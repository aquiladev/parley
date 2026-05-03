// Quote signing, accept handling, settlement submission. SPEC §4.2, §5.3.
// All EIP-712 signing happens here with the MM hot wallet via viem.

import { randomUUID } from "node:crypto";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DealTerms, Intent, Offer } from "@parley/shared";

import {
  canFill,
  maxOutflow,
  type Inventory,
  type InventoryLimits,
} from "./inventory.js";
import { dealForSigning, dealHash, DEAL_TYPES } from "./eip712.js";
import type { MmTokenRegistry, SupportedToken } from "./token-registry.js";
import type { MmWallet } from "./wallet.js";

const SETTLEMENT_ABI = parseAbi([
  "function lockMMSide((address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce) deal, bytes mmSig) external",
]);

export interface NegotiatorConfig {
  mmEnsName: string;
  mmAddress: Hex;
  settlementContract: Hex;
  chainId: number;
  privateKey: Hex;
  /** Reserve floors per token, address-keyed. Quotes that would push a
   *  token below its reserve are skipped. Inventory is NOT cached here —
   *  it's fetched live from chain per-intent and passed into `buildOffer`. */
  limits: InventoryLimits;
  /** Phase 10: per-MM token + pair allowlist with per-pair spread
   *  overrides. Replaces the hardcoded knownTokens.{usdc,weth} +
   *  spreadBps fields. */
  registry: MmTokenRegistry;
  offerExpiryMs: number;
  settlementWindowMs: number;
}

export interface PreparedOffer {
  offer: Offer;
  deal: DealTerms;
  /** Outflow this offer commits us to (so the main loop can debit inventory
   *  on accept). */
  outflow: { token: Hex; amount: bigint };
  /** Phase 9: true when this offer covers less than the user's full
   *  intent amount because inventory wasn't deep enough. The wire-format
   *  Offer doesn't carry a `partial` flag; the User Agent detects it by
   *  comparing `offer.deal.amountA` to `intent.amount`. We surface it
   *  here for MM-side logging. */
  partial: boolean;
}

/** Phase 10: structured decline reason so handleIntent can route to the
 *  right log/decline message. Matches the `reason` strings the MM emits
 *  on `offer.decline` AXL messages. */
export type DeclineReason =
  | "unsupported_token"
  | "unsupported_pair"
  | "insufficient_balance"
  | "price_unavailable"; // emitted by index.ts before reaching buildOffer

/** Decide whether to quote on `intent`, build a Deal, return the wire-form
 *  Offer + the Deal both parties will sign on-chain. `inventory` is the
 *  AVAILABLE inventory after subtracting the MM's reserve floor and any
 *  in-flight reservations from prior offers (caller in `index.ts` applies
 *  both before invoking). `referencePrice1e18` is the current Uniswap
 *  mid-price for THIS direction (`tokenOut natural units per 1 tokenIn
 *  natural unit × 1e18`) from the per-direction cache. The caller is
 *  responsible for the staleness check.
 *
 *  Phase 10: pair eligibility is checked via the MM's registry (token
 *  addresses configured by the operator + supported-pairs allowlist).
 *  Returns either a `PreparedOffer` or a `DeclineReason` so the caller
 *  can emit a precise `offer.decline` AXL message.
 */
export function buildOffer(
  intent: Intent,
  inventory: Inventory,
  referencePrice1e18: bigint,
  cfg: NegotiatorConfig,
): PreparedOffer | DeclineReason {
  const pair = pairFromIntent(intent, cfg.registry);
  if (pair === "unsupported_token" || pair === "unsupported_pair") return pair;

  const intentAmount = parseDecimal(intent.amount, pair.userInToken.decimals);
  const spreadBps = cfg.registry.getSpreadBps(
    pair.userInToken.address,
    pair.userOutToken.address,
  );
  // Phase 10 spread convention: the cached price is "tokenOut per
  // tokenIn × 1e18" for the user's direction, and the spread always
  // makes the user-effective rate WORSE (less tokenOut per tokenIn).
  // So we DECREASE the price by the spread, regardless of which two
  // tokens are involved. This fixes the directional asymmetry the
  // pre-Phase-10 code had when the user was selling WETH for USDC.
  const ourPrice = applyAdverseSpread(referencePrice1e18, spreadBps);

  const outflowCeiling = maxOutflow(
    inventory,
    cfg.limits,
    pair.userOutToken.address,
  );
  if (outflowCeiling === 0n) return "insufficient_balance";

  const sizing = sizeDeal({
    amountIn: intentAmount,
    pricePer1TokenIn1e18: ourPrice,
    decimalsIn: pair.userInToken.decimals,
    decimalsOut: pair.userOutToken.decimals,
    maxOutflowB: outflowCeiling,
  });

  // Pathological case: ceiling so small the back-derived amountA rounds
  // to zero. Decline rather than emit a zero-amount offer.
  if (sizing.amountA === 0n || sizing.amountB === 0n) {
    return "insufficient_balance";
  }

  const outflow = {
    token: pair.userOutToken.address,
    amount: sizing.amountB,
  };
  // Defense-in-depth: sizing already respected the ceiling.
  if (!canFill(inventory, cfg.limits, outflow)) return "insufficient_balance";

  const deadline = Math.floor(Date.now() / 1000) + Math.floor(cfg.offerExpiryMs / 1000);
  const nonce = nonceFromIntent(intent.id);

  const deal: DealTerms = {
    user: intent.agent_id,
    mm: cfg.mmAddress,
    tokenA: pair.userInToken.address,
    tokenB: pair.userOutToken.address,
    amountA: sizing.amountA.toString(),
    amountB: sizing.amountB.toString(),
    deadline,
    nonce: nonce.toString(),
  };

  // Express the actual amount this offer covers in human units so the
  // wire-format `offer.amount` matches what the deal pays out, not the
  // user's full intent. The User Agent's planner uses this to size the
  // Uniswap-tail leg.
  const amountHuman = formatHumanAmount(sizing.amountA, pair.userInToken.decimals);

  const offer: Offer = {
    type: "offer.quote",
    id: randomUUID(),
    intent_id: intent.id,
    mm_agent_id: cfg.mmAddress,
    mm_ens_name: cfg.mmEnsName,
    // Pair-agnostic price expression: "<tokenOut symbol> per <tokenIn symbol>"
    // formatted as a decimal string.
    price: formatPricePerTokenIn(ourPrice, pair.userInToken, pair.userOutToken),
    amount: amountHuman,
    expiry: deadline,
    settlement_window_ms: cfg.settlementWindowMs,
    deal,
    // EIP-712 sig over `deal`, populated by the caller via signDeal().
    signature: "0x",
  };

  return { offer, deal, outflow, partial: sizing.partial };
}

/** Phase 10: spread always makes the user's effective rate WORSE (less
 *  tokenOut per tokenIn given). Direction-symmetric since the cached
 *  reference is per-direction. */
function applyAdverseSpread(referencePrice1e18: bigint, spreadBps: number): bigint {
  // (1 - bps/10000) — clamps spread to [0, 9999] to avoid pathological
  // negative or zero prices on operator misconfiguration.
  const safeBps = Math.max(0, Math.min(9999, spreadBps));
  return (referencePrice1e18 * BigInt(10000 - safeBps)) / 10000n;
}

/** Sign the Deal struct with the MM's hot wallet (EIP-712). */
export async function signDeal(
  deal: DealTerms,
  cfg: NegotiatorConfig,
): Promise<Hex> {
  const account = privateKeyToAccount(cfg.privateKey);
  return account.signTypedData({
    domain: {
      name: "Parley",
      version: "1",
      chainId: cfg.chainId,
      verifyingContract: cfg.settlementContract,
    },
    types: DEAL_TYPES,
    primaryType: "Deal",
    message: dealForSigning(deal),
  });
}

/** Submit `lockMMSide(deal, mmSig)` from the MM hot wallet. Waits for one
 *  confirmation, returns the tx hash. */
export async function lockMMSide(
  deal: DealTerms,
  mmSig: Hex,
  cfg: NegotiatorConfig,
  wallet: MmWallet,
): Promise<Hex> {
  const e = dealForSigning(deal);
  const data = encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: "lockMMSide",
    args: [
      {
        user: e.user,
        mm: e.mm,
        tokenA: e.tokenA,
        tokenB: e.tokenB,
        amountA: e.amountA,
        amountB: e.amountB,
        deadline: e.deadline,
        nonce: e.nonce,
      },
      mmSig,
    ],
  });

  const account = wallet.walletClient.account;
  if (!account) throw new Error("wallet client has no account");
  const txHash = await wallet.walletClient.sendTransaction({
    account,
    chain: wallet.walletClient.chain,
    to: cfg.settlementContract,
    data,
  });
  await wallet.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  return txHash;
}

/** Off-chain digest matching Settlement.sol's dealHash() — useful for logging
 *  and for cross-checking a user's signature against what the contract expects. */
export function digest(deal: DealTerms, cfg: NegotiatorConfig): Hex {
  return dealHash(dealForSigning(deal), cfg.settlementContract, cfg.chainId);
}

// ---- internals --------------------------------------------------------------

interface PairResolution {
  /** What the user is sending us. */
  userInToken: SupportedToken;
  /** What we owe back to the user. */
  userOutToken: SupportedToken;
}

/** Resolve the user's intent against the MM's registry. Returns either a
 *  resolved pair (both tokens recognized + the unordered pair allowlisted)
 *  or a `DeclineReason` so the caller can emit a precise decline message. */
function pairFromIntent(
  intent: Intent,
  registry: MmTokenRegistry,
): PairResolution | "unsupported_token" | "unsupported_pair" {
  const baseInfo = registry.getToken(intent.base.address as Hex);
  const quoteInfo = registry.getToken(intent.quote.address as Hex);
  if (!baseInfo || !quoteInfo) return "unsupported_token";
  if (!registry.isSupportedPair(baseInfo.address, quoteInfo.address)) {
    return "unsupported_pair";
  }
  // intent.side === "sell": user sends `base`, wants `quote` back.
  // intent.side === "buy":  user wants `base`, sends `quote`.
  const userInToken = intent.side === "sell" ? baseInfo : quoteInfo;
  const userOutToken = intent.side === "sell" ? quoteInfo : baseInfo;
  return { userInToken, userOutToken };
}

/** Phase 10: pair-agnostic sizing. `pricePer1TokenIn1e18` represents
 *  "tokenOut natural units per 1 tokenIn natural unit, scaled to 1e18".
 *  The decimal handling is symmetric — works for any (decimalsIn,
 *  decimalsOut) combination, including identical decimals (e.g.,
 *  USDC/USDT both at 6) and inverted directions (WETH/USDC vs USDC/WETH).
 *
 *  Forward formula:
 *    amountOut_wei = (amountIn_wei × price × 10^(decOut - decIn)) / 10^18
 *  When `decOut < decIn`, the 10^(decOut-decIn) factor is negative; we
 *  flip to a divisor to keep bigint exponentiation valid.
 */
function sizeDeal(opts: {
  amountIn: bigint;
  pricePer1TokenIn1e18: bigint;
  decimalsIn: number;
  decimalsOut: number;
  /** Cap on amountB (the MM's outflow), in tokenOut wei. Phase 9
   *  partial-fill: when the forward-computed amountB exceeds this, both
   *  amountB and the back-derived amountA are scaled down to fit. */
  maxOutflowB: bigint;
}): { amountA: bigint; amountB: bigint; partial: boolean } {
  const { amountIn, pricePer1TokenIn1e18: price, decimalsIn, decimalsOut, maxOutflowB } = opts;
  const SCALE = 10n ** 18n;
  const dDelta = decimalsOut - decimalsIn; // signed

  let amountA = amountIn;
  let amountB = forwardConvert(amountA, price, dDelta, SCALE);
  let partial = false;
  if (amountB > maxOutflowB) {
    amountB = maxOutflowB;
    // Inverse: amountA = amountB × SCALE / (price × 10^dDelta)  if dDelta >= 0
    //          amountA = (amountB × SCALE × 10^(-dDelta)) / price  if dDelta < 0
    amountA = inverseConvert(amountB, price, dDelta, SCALE);
    partial = true;
  }
  return { amountA, amountB, partial };
}

function forwardConvert(
  amountInWei: bigint,
  price1e18: bigint,
  dDelta: number,
  SCALE: bigint,
): bigint {
  if (dDelta >= 0) {
    return (amountInWei * price1e18 * 10n ** BigInt(dDelta)) / SCALE;
  }
  return (amountInWei * price1e18) / SCALE / 10n ** BigInt(-dDelta);
}

function inverseConvert(
  amountOutWei: bigint,
  price1e18: bigint,
  dDelta: number,
  SCALE: bigint,
): bigint {
  if (dDelta >= 0) {
    return (amountOutWei * SCALE) / (price1e18 * 10n ** BigInt(dDelta));
  }
  return (amountOutWei * SCALE * 10n ** BigInt(-dDelta)) / price1e18;
}

function parseDecimal(human: string, decimals: number): bigint {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}

/** Format a `tokenOut per tokenIn × 1e18` price as a human-readable
 *  decimal string, with a brief `<symOut>/<symIn>` suffix the agent can
 *  surface in chat (e.g. "8221.81 USDC/WETH"). 6 fractional digits is
 *  enough resolution for any pair we'll quote on testnet. */
function formatPricePerTokenIn(
  price1e18: bigint,
  tokenIn: SupportedToken,
  tokenOut: SupportedToken,
): string {
  const whole = price1e18 / 10n ** 18n;
  const frac = price1e18 % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  const num = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return `${num} ${tokenOut.symbol}/${tokenIn.symbol}`;
}

/** Format an integer wei amount as a human decimal string. Trims trailing
 *  zeros from the fractional component but keeps the decimal point if the
 *  amount is fractional. Used for Offer.amount, which the User Agent
 *  consumes for plan-card prose and Uniswap-tail sizing. */
function formatHumanAmount(amountWei: bigint, decimals: number): string {
  if (decimals === 0) return amountWei.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = amountWei / divisor;
  const frac = amountWei % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function nonceFromIntent(intentId: string): bigint {
  // Deterministic nonce per intent id so retries don't collide. Phase 4
  // should swap this for a (user, mm) monotonic counter.
  let h = 0n;
  for (let i = 0; i < intentId.length; i++) {
    h = ((h << 5n) - h + BigInt(intentId.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  return h === 0n ? 1n : h;
}
