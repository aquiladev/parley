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

type PendingState = "awaiting_accept" | "awaiting_user_lock" | "submitted";

interface PendingDeal {
  offer: Offer;
  deal: DealTerms;
  dealHashHex: Hex;
  outflow: PreparedOffer["outflow"];
  counterpartyPeerId: string;
  mmSig: Hex;
  state: PendingState;
}

async function main(): Promise<void> {
  const env = readEnv();
  const account = privateKeyToAccount(env.privateKey);
  const wallet = buildWallet(env.privateKey, env.rpcUrl);
  const axl = new AxlClient(env.axlHttpUrl);

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

    // 2. Sweep pending deals: drop expired offers, submit lockMMSide for any
    //    deal that's now UserLocked on chain.
    await sweepPending(pending, cfg, wallet);

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
  log({
    event: "accept_received",
    offer_id: accept.offer_id,
    deal_hash: expectedHash,
  });
}

/** For each pending deal, advance the state machine based on chain state and
 *  the wall clock. Submits `lockMMSide` once the contract reports UserLocked. */
async function sweepPending(
  pending: Map<string, PendingDeal>,
  cfg: NegotiatorConfig,
  wallet: MmWallet,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const [offerId, p] of pending) {
    // Drop offers nobody accepted before the deadline.
    if (p.state === "awaiting_accept" && now >= p.deal.deadline) {
      log({ event: "offer_expired", offer_id: offerId, deal_hash: p.dealHashHex });
      pending.delete(offerId);
      continue;
    }

    if (p.state !== "awaiting_user_lock") continue;

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

    if (onchainState === STATE_NONE) {
      // user hasn't locked yet; check deadline
      if (now >= p.deal.deadline) {
        log({ event: "user_never_locked", offer_id: offerId, deal_hash: p.dealHashHex });
        pending.delete(offerId);
      }
      continue;
    }
    if (onchainState === STATE_USER_LOCKED) {
      try {
        const txHash = await lockMMSide(p.deal, p.mmSig, cfg, wallet);
        cfg.inventory[p.outflow.token] -= p.outflow.amount;
        p.state = "submitted";
        log({
          event: "mm_locked",
          offer_id: offerId,
          deal_hash: p.dealHashHex,
          tx: txHash,
          new_inventory_usdc_wei: cfg.inventory.usdc.toString(),
          new_inventory_weth_wei: cfg.inventory.weth.toString(),
        });
        pending.delete(offerId);
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
    if (
      onchainState === STATE_BOTH_LOCKED ||
      onchainState === STATE_SETTLED ||
      onchainState === STATE_REFUNDED
    ) {
      // Either we already submitted, or someone settled/refunded out from under us.
      log({
        event: "deal_terminal",
        offer_id: offerId,
        deal_hash: p.dealHashHex,
        chain_state: onchainState,
      });
      pending.delete(offerId);
    }
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
