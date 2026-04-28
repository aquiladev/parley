// MM Agent entry — deterministic state machine, no LLM in the pricing path.
// SPEC §4.2.
//
//   LISTENING → INTENT_RECEIVED → PRICING → QUOTE_SENT
//             → AWAITING_ACCEPT → AWAITING_USER_LOCK → SETTLING → COMPLETE → LISTENING
//
// Phase 1 simplifications (per ROADMAP.md):
//   - hardcoded inventory + spread (env-driven)
//   - hardcoded TWAP reference price (Uniswap pool oracle = Phase 4)
//   - peer discovery is whoever sends us an intent (no ENS, no fan-out)
//   - chain state polling, not event subscription (Phase 4 swaps in viem.watchContractEvent)

import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  Accept,
  DealTerms,
  Intent,
  Offer,
  ParleyMessage,
  TokenRef,
  TradeRecord,
} from "@parley/shared";

import { AxlClient } from "./axl-client.js";
import { loadInventoryFromEnv } from "./inventory.js";
import {
  buildOffer,
  digest,
  lockMMSide,
  signDeal,
  type NegotiatorConfig,
  type PreparedOffer,
} from "./negotiator.js";
import { ReputationPublisher } from "./reputation-publisher.js";
import { buildWallet, type MmWallet } from "./wallet.js";

const POLL_INTERVAL_MS = 2_000;

const SETTLEMENT_ABI = parseAbi([
  "function getState(bytes32 dealHash) external view returns (uint8)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

// Mirror of Settlement.sol's DealState enum.
const STATE_NONE = 0;
const STATE_USER_LOCKED = 1;
const STATE_BOTH_LOCKED = 2;
const STATE_SETTLED = 3;
const STATE_REFUNDED = 4;

interface Env {
  axlHttpUrl: string;
  rpcUrl: string;
  settlementContract: Hex;
  chainId: number;
  privateKey: Hex;
  spreadBps: number;
  ensName: string;
  offerExpiryMs: number;
  settlementWindowMs: number;
  knownTokens: { usdc: TokenRef; weth: TokenRef };
}

function readEnv(): Env {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v || v === "") throw new Error(`env var ${name} is required`);
    return v;
  };

  const settlementContract = required("SETTLEMENT_CONTRACT_ADDRESS") as Hex;
  if (settlementContract === "0x0000000000000000000000000000000000000000") {
    throw new Error("SETTLEMENT_CONTRACT_ADDRESS is the zero address — deploy first");
  }

  const usdcAddr = (process.env["SEPOLIA_USDC_ADDRESS"] ??
    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Hex;
  const wethAddr = (process.env["SEPOLIA_WETH_ADDRESS"] ??
    "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14") as Hex;

  return {
    axlHttpUrl: process.env["AXL_HTTP_URL"] ?? "http://localhost:9012",
    rpcUrl: required("SEPOLIA_RPC_URL"),
    settlementContract,
    chainId: 11155111,
    privateKey: required("MM_EVM_PRIVATE_KEY") as Hex,
    spreadBps: Number(process.env["MM_SPREAD_BPS"] ?? "20"),
    ensName: process.env["MM_ENS_NAME"] ?? "mm-1.parley.eth",
    offerExpiryMs: Number(process.env["MM_OFFER_EXPIRY_MS"] ?? "120000"),
    settlementWindowMs: Number(process.env["MM_SETTLEMENT_WINDOW_MS"] ?? "300000"),
    knownTokens: {
      usdc: { chain_id: 11155111, address: usdcAddr, symbol: "USDC", decimals: 6 },
      weth: { chain_id: 11155111, address: wethAddr, symbol: "WETH", decimals: 18 },
    },
  };
}

// Phase 4 state machine — keeps entries in `pending` past lockMMSide so we
// can write a TradeRecord at the terminal transition (settled / refunded /
// timeout). Without that, reputation never accrues.
type PendingState =
  | "awaiting_accept"
  | "awaiting_user_lock"
  | "mm_submitted"
  | "recorded";

interface PendingDeal {
  offer: Offer;
  deal: DealTerms;
  dealHashHex: Hex;
  outflow: PreparedOffer["outflow"];
  counterpartyPeerId: string;
  mmSig: Hex;
  /** From the user's Accept envelope — the EIP-712 sig over the Deal that
   *  the user submitted via lockUserSide. Stored so we can include it in
   *  the TradeRecord (SPEC §7.1 `user_signature`). */
  userSig: Hex | null;
  /** Unix seconds when we first observed the on-chain state advance to
   *  USER_LOCKED / BOTH_LOCKED. Approximate; exact block timestamps would
   *  require a getBlock call we skip in Phase 4 to keep the sweep cheap. */
  user_locked_at: number | null;
  mm_locked_at: number | null;
  state: PendingState;
}

async function main(): Promise<void> {
  const env = readEnv();
  const account = privateKeyToAccount(env.privateKey);
  const wallet = buildWallet(env.privateKey, env.rpcUrl);
  const axl = new AxlClient(env.axlHttpUrl);
  const reputation = new ReputationPublisher({
    mmEnsName: env.ensName,
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
  });

  const { inventory, limits } = loadInventoryFromEnv({
    usdcDecimals: env.knownTokens.usdc.decimals,
    wethDecimals: env.knownTokens.weth.decimals,
  });

  const cfg: NegotiatorConfig = {
    mmEnsName: env.ensName,
    mmAddress: account.address,
    spreadBps: env.spreadBps,
    settlementContract: env.settlementContract,
    chainId: env.chainId,
    privateKey: env.privateKey,
    inventory,
    limits,
    knownTokens: env.knownTokens,
    offerExpiryMs: env.offerExpiryMs,
    settlementWindowMs: env.settlementWindowMs,
  };

  // Phase 1 only: against TestERC20 mocks, self-mint inventory if low and
  // approve Settlement to spend it. Production MM operators fund their hot
  // wallet out-of-band and approve once.
  await ensureMmFundedAndApproved(cfg, wallet);

  const topo = await axl.topology();
  log({
    event: "boot",
    mm_address: account.address,
    ens_name: env.ensName,
    settlement: env.settlementContract,
    spread_bps: env.spreadBps,
    inventory_usdc_wei: inventory.usdc.toString(),
    inventory_weth_wei: inventory.weth.toString(),
    axl_url: env.axlHttpUrl,
    axl_pubkey: topo.ourPublicKey,
    axl_peers: topo.peers.length,
  });

  // Active negotiations and chain submissions, keyed by offer id.
  const pending = new Map<string, PendingDeal>();

  while (true) {
    // 1. Drain any inbound AXL message.
    try {
      const inbox = await axl.recv();
      if (inbox) {
        const msg = parseMessage(inbox.body);
        if (msg) {
          await dispatch(msg, inbox.fromPeerId, cfg, axl, pending);
        } else {
          log({ event: "unparsable_message" });
        }
      }
    } catch (err) {
      log({ event: "recv_error", err: (err as Error).message });
    }

    // 2. Sweep pending deals: advance through state transitions, write
    //    TradeRecords at terminal states, publish reputation_root updates.
    await sweepPending(pending, cfg, wallet, reputation);

    await sleep(POLL_INTERVAL_MS);
  }
}

async function dispatch(
  msg: ParleyMessage,
  fromPeerId: string,
  cfg: NegotiatorConfig,
  axl: AxlClient,
  pending: Map<string, PendingDeal>,
): Promise<void> {
  try {
    switch (msg.type) {
      case "intent.broadcast":
        await handleIntent(msg, fromPeerId, cfg, axl, pending);
        break;
      case "offer.accept":
        handleAccept(msg, cfg, pending);
        break;
      default:
        log({ event: "ignored", type: msg.type });
    }
  } catch (err) {
    log({ event: "handler_error", type: msg.type, err: (err as Error).message });
  }
}

async function handleIntent(
  intent: Intent,
  fromPeerId: string,
  cfg: NegotiatorConfig,
  axl: AxlClient,
  pending: Map<string, PendingDeal>,
): Promise<void> {
  log({
    event: "intent_received",
    intent_id: intent.id,
    side: intent.side,
    from_header: fromPeerId,
    from_field: intent.from_axl_pubkey,
  });

  const prepared = buildOffer(intent, cfg);
  if (!prepared) {
    log({
      event: "intent_skipped",
      intent_id: intent.id,
      reason: "unsupported_pair_or_inventory",
    });
    return;
  }

  const sig = await signDeal(prepared.deal, cfg);
  const offer: Offer = { ...prepared.offer, signature: sig };
  const dealHashHex = digest(prepared.deal, cfg);

  // Reply destination = the user's full AXL pubkey from the intent body, not
  // the prefix-padded X-From-Peer-Id header form (whose routability as a
  // destination is empirically unverified). See `axl_transport_quirks` memory.
  const replyTo = intent.from_axl_pubkey;

  pending.set(offer.id, {
    offer,
    deal: prepared.deal,
    dealHashHex,
    outflow: prepared.outflow,
    counterpartyPeerId: replyTo,
    mmSig: sig,
    userSig: null,
    user_locked_at: null,
    mm_locked_at: null,
    state: "awaiting_accept",
  });

  await axl.send(replyTo, JSON.stringify(offer));
  log({
    event: "offer_sent",
    intent_id: intent.id,
    offer_id: offer.id,
    deal_hash: dealHashHex,
    price: offer.price,
    expiry: offer.expiry,
  });
}

function handleAccept(
  accept: Accept,
  cfg: NegotiatorConfig,
  pending: Map<string, PendingDeal>,
): void {
  const found = pending.get(accept.offer_id);
  if (!found) {
    log({ event: "accept_unknown_offer", offer_id: accept.offer_id });
    return;
  }
  if (found.state !== "awaiting_accept") {
    log({
      event: "accept_unexpected_state",
      offer_id: accept.offer_id,
      state: found.state,
    });
    return;
  }
  const expectedHash = digest(found.deal, cfg);
  if (accept.deal_hash.toLowerCase() !== expectedHash.toLowerCase()) {
    log({
      event: "accept_hash_mismatch",
      offer_id: accept.offer_id,
      expected: expectedHash,
      got: accept.deal_hash,
    });
    return;
  }

  found.state = "awaiting_user_lock";
  // Spec §5.2: Accept's `signature` is the user's EIP-712 sig over the Deal
  // (the same sig they pass to lockUserSide). Store for the eventual
  // TradeRecord; trust here is bounded — if it's wrong, the chain will reject
  // their lock anyway, and our record's user_signature ends up garbage but
  // the deal_hash + settled fields stay correct (which is what scoring uses).
  found.userSig = accept.signature;
  log({
    event: "accept_received",
    offer_id: accept.offer_id,
    deal_hash: expectedHash,
  });
}

/** Advance each pending deal's state machine based on chain state and the
 *  wall clock. Writes a TradeRecord (and publishes reputation_root) at each
 *  terminal transition. */
async function sweepPending(
  pending: Map<string, PendingDeal>,
  cfg: NegotiatorConfig,
  wallet: MmWallet,
  reputation: ReputationPublisher,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const [offerId, p] of pending) {
    // Drop offers nobody accepted before the deadline. Pre-accept = no trade
    // happened — nothing to record.
    if (p.state === "awaiting_accept" && now >= p.deal.deadline) {
      log({ event: "offer_expired", offer_id: offerId, deal_hash: p.dealHashHex });
      pending.delete(offerId);
      continue;
    }

    if (p.state === "recorded") {
      pending.delete(offerId);
      continue;
    }

    if (p.state !== "awaiting_user_lock" && p.state !== "mm_submitted") continue;

    let onchainState: number;
    try {
      onchainState = Number(
        await wallet.publicClient.readContract({
          address: cfg.settlementContract,
          abi: SETTLEMENT_ABI,
          functionName: "getState",
          args: [p.dealHashHex],
        }),
      );
    } catch (err) {
      log({
        event: "getstate_error",
        offer_id: offerId,
        err: (err as Error).message,
      });
      continue;
    }

    // ---- awaiting_user_lock ----------------------------------------------
    if (p.state === "awaiting_user_lock") {
      if (onchainState === STATE_NONE) {
        if (now >= p.deal.deadline) {
          // User accepted but never locked → §7.3 "failed acceptance".
          await recordTerminal(p, reputation, {
            settled: false,
            defaulted: "user",
          });
          p.state = "recorded";
          pending.delete(offerId);
        }
        continue;
      }
      if (onchainState === STATE_USER_LOCKED) {
        if (p.user_locked_at === null) p.user_locked_at = now;
        try {
          const txHash = await lockMMSide(p.deal, p.mmSig, cfg, wallet);
          cfg.inventory[p.outflow.token] -= p.outflow.amount;
          p.mm_locked_at = Math.floor(Date.now() / 1000);
          p.state = "mm_submitted";
          log({
            event: "mm_locked",
            offer_id: offerId,
            deal_hash: p.dealHashHex,
            tx: txHash,
            new_inventory_usdc_wei: cfg.inventory.usdc.toString(),
            new_inventory_weth_wei: cfg.inventory.weth.toString(),
          });
        } catch (err) {
          log({
            event: "lockmm_error",
            offer_id: offerId,
            deal_hash: p.dealHashHex,
            err: (err as Error).message,
          });
        }
        continue;
      }
      if (onchainState === STATE_BOTH_LOCKED) {
        // Someone (the user, or a courtesy retry) submitted lockMMSide for
        // us — unusual. Treat as if we'd done it ourselves.
        if (p.user_locked_at === null) p.user_locked_at = now;
        if (p.mm_locked_at === null) p.mm_locked_at = now;
        p.state = "mm_submitted";
        log({ event: "both_locked_observed", offer_id: offerId, deal_hash: p.dealHashHex });
        continue;
      }
      if (onchainState === STATE_SETTLED) {
        if (p.user_locked_at === null) p.user_locked_at = now;
        if (p.mm_locked_at === null) p.mm_locked_at = now;
        await recordTerminal(p, reputation, { settled: true, defaulted: "none" });
        p.state = "recorded";
        pending.delete(offerId);
        continue;
      }
      if (onchainState === STATE_REFUNDED) {
        if (p.user_locked_at === null) p.user_locked_at = now;
        await recordTerminal(p, reputation, {
          settled: false,
          defaulted: p.mm_locked_at === null ? "mm" : "timeout",
        });
        p.state = "recorded";
        pending.delete(offerId);
        continue;
      }
    }

    // ---- mm_submitted ----------------------------------------------------
    if (p.state === "mm_submitted") {
      if (onchainState === STATE_SETTLED) {
        await recordTerminal(p, reputation, { settled: true, defaulted: "none" });
        p.state = "recorded";
        pending.delete(offerId);
        continue;
      }
      if (onchainState === STATE_REFUNDED) {
        await recordTerminal(p, reputation, { settled: false, defaulted: "timeout" });
        p.state = "recorded";
        pending.delete(offerId);
        continue;
      }
      if (onchainState === STATE_BOTH_LOCKED && now >= p.deal.deadline) {
        // Both locked but settle never landed before deadline. Caller could
        // refund either side; from our side we're done.
        await recordTerminal(p, reputation, { settled: false, defaulted: "timeout" });
        p.state = "recorded";
        pending.delete(offerId);
        continue;
      }
      // BothLocked && before deadline → keep waiting for settle.
    }
  }
}

/** Build a TradeRecord from PendingDeal state, publish via 0G Storage + ENS. */
async function recordTerminal(
  p: PendingDeal,
  reputation: ReputationPublisher,
  outcome: { settled: boolean; defaulted: TradeRecord["defaulted"] },
): Promise<void> {
  const record: TradeRecord = {
    trade_id: p.dealHashHex,
    timestamp: Math.floor(Date.now() / 1000),
    user_agent: p.deal.user,
    mm_agent: p.deal.mm,
    pair: "USDC/WETH", // Phase 4: only pair the MM trades.
    amount_a: p.deal.amountA,
    amount_b: p.deal.amountB,
    negotiated_price: p.offer.price,
    user_locked: p.user_locked_at !== null,
    user_locked_at: p.user_locked_at ?? 0,
    mm_locked: p.mm_locked_at !== null,
    mm_locked_at: p.mm_locked_at ?? 0,
    settled: outcome.settled,
    settlement_block: null,
    defaulted: outcome.defaulted,
    user_signature: p.userSig ?? "0x",
    mm_signature: p.mmSig,
  };
  log({
    event: "writing_trade_record",
    deal_hash: p.dealHashHex,
    settled: outcome.settled,
    defaulted: outcome.defaulted,
  });
  try {
    const r = await reputation.publish(record);
    log({
      event: "trade_record_published",
      deal_hash: p.dealHashHex,
      record_root: r.recordHash,
      index_root: r.indexHash,
      ens_tx: r.ensTx,
    });
  } catch (err) {
    log({
      event: "trade_record_publish_error",
      deal_hash: p.dealHashHex,
      err: (err as Error).message,
    });
  }
}

async function ensureMmFundedAndApproved(
  cfg: NegotiatorConfig,
  wallet: MmWallet,
): Promise<void> {
  const targets: Array<{ token: Hex; symbol: string; target: bigint }> = [
    {
      token: cfg.knownTokens.usdc.address,
      symbol: "USDC",
      target: cfg.inventory.usdc,
    },
    {
      token: cfg.knownTokens.weth.address,
      symbol: "WETH",
      target: cfg.inventory.weth,
    },
  ];

  for (const t of targets) {
    if (t.target === 0n) continue; // operator chose not to quote in this token

    const balance = (await wallet.publicClient.readContract({
      address: t.token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet.address],
    })) as bigint;

    if (balance < t.target) {
      const mintAmount = t.target * 2n; // headroom for repeated runs
      log({
        event: "self_minting",
        token: t.token,
        symbol: t.symbol,
        balance_wei: balance.toString(),
        mint_wei: mintAmount.toString(),
      });
      const txHash = await wallet.walletClient.sendTransaction({
        account: wallet.walletClient.account!,
        chain: wallet.walletClient.chain,
        to: t.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "mint",
          args: [wallet.address, mintAmount],
        }),
      });
      await wallet.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });
    }

    const allowance = (await wallet.publicClient.readContract({
      address: t.token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet.address, cfg.settlementContract],
    })) as bigint;

    // Approve unlimited (Phase 1; cap-and-reapprove pattern is Phase 4 polish).
    if (allowance < t.target) {
      log({
        event: "approving",
        token: t.token,
        symbol: t.symbol,
        spender: cfg.settlementContract,
      });
      const txHash = await wallet.walletClient.sendTransaction({
        account: wallet.walletClient.account!,
        chain: wallet.walletClient.chain,
        to: t.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cfg.settlementContract, 2n ** 256n - 1n],
        }),
      });
      await wallet.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });
    }
  }
}

function parseMessage(body: Buffer): ParleyMessage | null {
  try {
    const j = JSON.parse(body.toString("utf-8")) as ParleyMessage;
    if (typeof j !== "object" || j === null || typeof j.type !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`[mm-agent] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
