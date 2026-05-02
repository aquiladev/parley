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
  OfferDecline,
  ParleyMessage,
  TokenRef,
  TradeRecord,
} from "@parley/shared";

import { AxlClient } from "./axl-client.js";
import { ensureAxlPubkeyOnEns } from "./axl-identity.js";
import {
  applyReservations,
  fetchInventoryFromChain,
  loadReserveLimitsFromEnv,
  reservedOutflows,
} from "./inventory.js";
import {
  buildOffer,
  digest,
  lockMMSide,
  signDeal,
  type NegotiatorConfig,
  type PreparedOffer,
} from "./negotiator.js";
import { ReputationPublisher } from "./reputation-publisher.js";
import {
  createUniswapReference,
  type ReferencePair,
  type UniswapReference,
} from "./uniswap-reference.js";
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
  /** Background refresh cadence for the Uniswap reference price. */
  priceRefreshIntervalMs: number;
  /** Hard staleness gate — decline-to-quote if the cached price is older
   *  than this when an intent arrives. */
  priceMaxStaleMs: number;
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
    offerExpiryMs: Number(process.env["MM_OFFER_EXPIRY_MS"] ?? "300000"),
    settlementWindowMs: Number(process.env["MM_SETTLEMENT_WINDOW_MS"] ?? "300000"),
    priceRefreshIntervalMs: Number(process.env["MM_PRICE_REFRESH_INTERVAL_MS"] ?? "15000"),
    priceMaxStaleMs: Number(process.env["MM_PRICE_MAX_STALE_MS"] ?? "60000"),
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

  const limits = loadReserveLimitsFromEnv({
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
    limits,
    knownTokens: env.knownTokens,
    offerExpiryMs: env.offerExpiryMs,
    settlementWindowMs: env.settlementWindowMs,
  };

  // Approve the Settlement contract to spend our tokens. Inventory itself
  // comes from chain `balanceOf` per-intent — there's no env-driven cap.
  // Against legacy TestERC20 mocks (Phase 1 leftover) this also probes a
  // best-effort `mint()` so devs running on those tokens don't have to fund
  // manually; on real Sepolia USDC/WETH the mint reverts and we degrade.
  await ensureMmFundedAndApproved(cfg, wallet);

  // Snapshot starting balance once for the boot log so the operator can
  // sanity-check funding. Per-intent quoting reads its own snapshot.
  const startingInventory = await fetchInventoryFromChain(
    wallet.publicClient,
    account.address,
    env.knownTokens,
  );

  const topo = await axl.topology();
  log({
    event: "boot",
    mm_address: account.address,
    ens_name: env.ensName,
    settlement: env.settlementContract,
    spread_bps: env.spreadBps,
    on_chain_balance_usdc_wei: startingInventory.usdc.toString(),
    on_chain_balance_weth_wei: startingInventory.weth.toString(),
    min_usdc_reserve_wei: limits.min_usdc.toString(),
    min_weth_reserve_wei: limits.min_weth.toString(),
    axl_url: env.axlHttpUrl,
    axl_pubkey: topo.ourPublicKey,
    axl_peers: topo.peers.length,
  });

  // Self-heal ENS axl_pubkey. Default-on; opt-out via MM_AUTO_REGISTER_AXL=false.
  // Mismatch happens whenever axl.pem rotates (fresh container, new operator,
  // intentional rotation). Without this the User Agent dials a stale overlay
  // IPv6 and broadcast_intent hangs in a 127s gVisor TCP SYN timeout.
  const autoRegisterEnv = (process.env["MM_AUTO_REGISTER_AXL"] ?? "true").toLowerCase();
  const autoRegister = !["false", "0", "no", "off"].includes(autoRegisterEnv);
  try {
    const r = await ensureAxlPubkeyOnEns(
      {
        mmEnsName: env.ensName,
        rpcUrl: env.rpcUrl,
        privateKey: env.privateKey,
        axlHttpUrl: env.axlHttpUrl,
        autoRegister,
      },
      log,
    );
    log({ event: "axl_identity_sync_done", status: r.status });
  } catch (err) {
    // Re-throw to fail boot — this is the right behavior for both
    // autoRegister=false (operator must fix) AND for unexpected errors
    // (better to crash than serve traffic with a broken identity).
    process.stderr.write(
      `[mm-agent] FATAL: axl identity sync failed: ${(err as Error).message}\n`,
    );
    throw err;
  }

  // Phase 8: live Uniswap reference price. Background-refreshes the
  // mid-price for the WETH/USDC pair; intent path reads synchronously
  // from the in-memory cache. start() blocks on the first fetch so we
  // either boot with a warm cache (happy path) or boot logged-but-empty
  // (RPC unreachable; the MM declines-to-quote until self-heal). Either
  // way, no per-intent RPC latency.
  const referencePair: ReferencePair = {
    tokenIn: env.knownTokens.weth.address,
    tokenOut: env.knownTokens.usdc.address,
    decimalsIn: env.knownTokens.weth.decimals,
    decimalsOut: env.knownTokens.usdc.decimals,
  };
  const reference = createUniswapReference({
    client: wallet.publicClient,
    chainId: env.chainId,
    pair: referencePair,
    refreshIntervalMs: env.priceRefreshIntervalMs,
    log,
  });
  await reference.start();

  // Active negotiations and chain submissions, keyed by offer id.
  const pending = new Map<string, PendingDeal>();

  while (true) {
    // 1. Drain any inbound AXL message.
    try {
      const inbox = await axl.recv();
      if (inbox) {
        const msg = parseMessage(inbox.body);
        if (msg) {
          await dispatch(
            msg,
            inbox.fromPeerId,
            cfg,
            wallet,
            axl,
            pending,
            reference,
            referencePair,
            env.priceMaxStaleMs,
          );
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
  wallet: MmWallet,
  axl: AxlClient,
  pending: Map<string, PendingDeal>,
  reference: UniswapReference,
  referencePair: ReferencePair,
  priceMaxStaleMs: number,
): Promise<void> {
  try {
    switch (msg.type) {
      case "intent.broadcast":
        await handleIntent(
          msg,
          fromPeerId,
          cfg,
          wallet,
          axl,
          pending,
          reference,
          referencePair,
          priceMaxStaleMs,
        );
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
  wallet: MmWallet,
  axl: AxlClient,
  pending: Map<string, PendingDeal>,
  reference: UniswapReference,
  referencePair: ReferencePair,
  priceMaxStaleMs: number,
): Promise<void> {
  log({
    event: "intent_received",
    intent_id: intent.id,
    side: intent.side,
    from_header: fromPeerId,
    from_field: intent.from_axl_pubkey,
  });

  // Synchronous cache read — no RPC on the intent path. If the background
  // refresher hasn't produced a value yet (RPC unreachable at boot) or
  // the cached value has aged past the staleness gate, we DECLINE to
  // quote rather than emit a stale price. The User Agent's existing
  // "fewer offers than expected → fall through to Uniswap fallback"
  // flow handles silence cleanly.
  const cached = reference.read(referencePair);
  const cacheAge = cached ? Date.now() - cached.fetchedAt : null;
  if (cached === null || cacheAge === null || cacheAge > priceMaxStaleMs) {
    log({
      event: "offer_declined",
      reason: "price_unavailable",
      intent_id: intent.id,
      cache_age_ms: cacheAge,
      max_stale_ms: priceMaxStaleMs,
    });
    await sendDecline(axl, intent, cfg, "price_unavailable");
    return;
  }

  // Live chain read — the source of truth for what we actually have to trade.
  // Decouples quoting decisions from any env-driven cap so a cold restart
  // with the same hot wallet picks up exactly where the chain says we are.
  const chainInventory = await fetchInventoryFromChain(
    wallet.publicClient,
    cfg.mmAddress,
    cfg.knownTokens,
  );

  // Phase 9 reservation: subtract outflows promised on still-live offers
  // (signed but not yet settled/refunded). Without this, two concurrent
  // intents from different users get quoted against the same chain
  // balance and the MM accepts more than it can deliver. The MM's main
  // loop is single-threaded so `pending.set` always completes before
  // the next handleIntent reads it — no lock needed.
  const reserved = reservedOutflows(
    Array.from(pending.values(), (p) => ({
      outflow: p.outflow,
      state: p.state,
      deadlineSec: p.deal.deadline,
    })),
  );
  const available = applyReservations(chainInventory, reserved);

  const prepared = buildOffer(intent, available, cached.value, cfg);
  if (!prepared) {
    log({
      event: "intent_skipped",
      intent_id: intent.id,
      reason: "unsupported_pair_or_insufficient_balance",
      on_chain_balance_usdc_wei: chainInventory.usdc.toString(),
      on_chain_balance_weth_wei: chainInventory.weth.toString(),
      reserved_usdc_wei: reserved.usdc.toString(),
      reserved_weth_wei: reserved.weth.toString(),
      available_usdc_wei: available.usdc.toString(),
      available_weth_wei: available.weth.toString(),
    });
    await sendDecline(
      axl,
      intent,
      cfg,
      "unsupported_pair_or_insufficient_balance",
    );
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
    partial: prepared.partial,
    intent_amount: intent.amount,
    offer_amount: offer.amount,
  });
}

/** Phase 8b: send an `offer.decline` so the User Agent can short-circuit
 *  its offer-collection wait instead of timing out. Failure to send is
 *  logged but non-fatal — the User Agent's existing timeout path is the
 *  fallback. Reply destination is the user's full AXL pubkey from the
 *  intent body, matching the offer-send pattern above. */
async function sendDecline(
  axl: AxlClient,
  intent: Intent,
  cfg: NegotiatorConfig,
  reason: string,
): Promise<void> {
  const decline: OfferDecline = {
    type: "offer.decline",
    intent_id: intent.id,
    mm_agent_id: cfg.mmAddress,
    mm_ens_name: cfg.mmEnsName,
    reason,
    timestamp: new Date().toISOString(),
  };
  try {
    await axl.send(intent.from_axl_pubkey, JSON.stringify(decline));
    log({ event: "decline_sent", intent_id: intent.id, reason });
  } catch (err) {
    log({
      event: "decline_send_failed",
      intent_id: intent.id,
      reason,
      err: (err as Error).message,
    });
  }
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
    if (p.state === "recorded") {
      pending.delete(offerId);
      continue;
    }

    // Read chain state for every active offer, including those still in
    // `awaiting_accept`. The AXL Accept message may be in flight or never
    // coming — chain state is the source of truth. Without this probe, an
    // Accept that arrives 1 second after our offer-expiry check causes us
    // to silently drop the offer even though the user already locked
    // funds on-chain. The user is then stuck refunding instead of getting
    // a counter-locked, settle-able trade.
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

    // ---- awaiting_accept -------------------------------------------------
    // Chain state takes priority over the Accept message. If the user
    // already locked, promote regardless of whether the AXL Accept arrived
    // (it may have raced our timer). If chain says nothing happened and
    // the deadline has passed, this is a real expiry.
    if (p.state === "awaiting_accept") {
      if (
        onchainState === STATE_USER_LOCKED ||
        onchainState === STATE_BOTH_LOCKED
      ) {
        log({
          event: "accept_implied_by_chain",
          offer_id: offerId,
          deal_hash: p.dealHashHex,
          onchain_state: onchainState,
          deadline_in_sec: p.deal.deadline - now,
        });
        p.state = "awaiting_user_lock";
        if (p.user_locked_at === null) p.user_locked_at = now;
        // fall through to the awaiting_user_lock branch below.
      } else if (now >= p.deal.deadline) {
        log({
          event: "offer_expired",
          offer_id: offerId,
          deal_hash: p.dealHashHex,
        });
        pending.delete(offerId);
        continue;
      } else {
        // Still within deadline, no on-chain action — keep waiting.
        continue;
      }
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
          // No in-memory inventory decrement: chain balance is the source of
          // truth and `lockMMSide` itself moved tokens via transferFrom.
          // Subsequent intents read fresh balance via fetchInventoryFromChain.
          p.mm_locked_at = Math.floor(Date.now() / 1000);
          p.state = "mm_submitted";
          log({
            event: "mm_locked",
            offer_id: offerId,
            deal_hash: p.dealHashHex,
            tx: txHash,
            outflow_token: p.outflow.token,
            outflow_amount_wei: p.outflow.amount.toString(),
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
  // Phase 6: chain balance is the source of truth. There's no env-driven
  // "target" cap to compare against — we just (a) optionally probe-mint for
  // dev TestERC20s when balance is 0, and (b) ensure the Settlement contract
  // has unlimited allowance over whatever the wallet holds.
  //
  // Runs once at boot. Operator can top up afterward without a restart;
  // re-running this function on each new fund would be redundant since
  // unlimited approve is already in place.

  const tokens: Array<{ token: Hex; symbol: string }> = [
    { token: cfg.knownTokens.usdc.address, symbol: "USDC" },
    { token: cfg.knownTokens.weth.address, symbol: "WETH" },
  ];

  for (const t of tokens) {
    let balance = (await wallet.publicClient.readContract({
      address: t.token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet.address],
    })) as bigint;

    // Best-effort dev convenience: if balance is 0, probe `mint()`. Works
    // against legacy TestERC20s (Phase 1 mocks); reverts harmlessly on
    // real Sepolia USDC/WETH where it's not authorized. No-throw on revert
    // because real-token failure isn't an error condition for production.
    if (balance === 0n) {
      const probeMintAmount = t.symbol === "USDC" ? 10_000_000_000n : 10_000_000_000_000_000_000n;
      log({
        event: "attempting_self_mint",
        token: t.token,
        symbol: t.symbol,
        mint_wei: probeMintAmount.toString(),
      });
      try {
        const txHash = await wallet.walletClient.sendTransaction({
          account: wallet.walletClient.account!,
          chain: wallet.walletClient.chain,
          to: t.token,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "mint",
            args: [wallet.address, probeMintAmount],
          }),
        });
        await wallet.publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
        });
        balance = (await wallet.publicClient.readContract({
          address: t.token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [wallet.address],
        })) as bigint;
        log({
          event: "self_mint_ok",
          symbol: t.symbol,
          balance_wei: balance.toString(),
          minted_wei: balance.toString(),
        });
      } catch (err) {
        // Expected on production tokens — degrade silently.
        log({
          event: "self_mint_unavailable",
          token: t.token,
          symbol: t.symbol,
          hint:
            t.symbol === "USDC"
              ? "Sepolia USDC: claim from https://faucet.circle.com and send to the MM hot wallet"
              : t.symbol === "WETH"
                ? "Sepolia WETH: send Sepolia ETH to 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14 (auto-wraps) then transfer here"
                : "Fund the MM hot wallet manually",
          underlying: (err as Error).message,
        });
      }
    }

    // Approve unlimited regardless of current balance. This is a one-time
    // setup so future external funding doesn't require a re-approve. If
    // allowance is already at uint256.max we skip the tx.
    const allowance = (await wallet.publicClient.readContract({
      address: t.token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet.address, cfg.settlementContract],
    })) as bigint;

    const MAX = 2n ** 256n - 1n;
    // Reapprove if the current allowance is less than half of MAX — gives
    // headroom against the (highly unlikely) case where the contract drained
    // most of an unlimited approval.
    if (allowance < MAX / 2n) {
      log({
        event: "approving",
        token: t.token,
        symbol: t.symbol,
        spender: cfg.settlementContract,
        current_balance_wei: balance.toString(),
      });
      const txHash = await wallet.walletClient.sendTransaction({
        account: wallet.walletClient.account!,
        chain: wallet.walletClient.chain,
        to: t.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cfg.settlementContract, MAX],
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
