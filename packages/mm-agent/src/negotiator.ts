// Quote signing, accept handling, settlement submission. SPEC §4.2, §5.3.
// All EIP-712 signing happens here with the MM hot wallet via viem.

import { randomUUID } from "node:crypto";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DealTerms, Intent, Offer, TokenRef } from "@parley/shared";

import {
  canFill,
  maxOutflow,
  type Inventory,
  type InventoryLimits,
} from "./inventory.js";
import { dealForSigning, dealHash, DEAL_TYPES } from "./eip712.js";
import { quote } from "./pricing.js";
import type { MmWallet } from "./wallet.js";

const SETTLEMENT_ABI = parseAbi([
  "function lockMMSide((address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce) deal, bytes mmSig) external",
]);

export interface NegotiatorConfig {
  mmEnsName: string; // human label only in Phase 1; ENS resolution lands in Phase 3
  mmAddress: Hex;
  spreadBps: number;
  settlementContract: Hex;
  chainId: number;
  privateKey: Hex;
  /** Reserve floors per token. Quotes that would push a token below its
   *  reserve are skipped. Default 0 / 0. Inventory is NOT cached here — it's
   *  fetched live from chain per-intent and passed into `buildOffer`. */
  limits: InventoryLimits;
  /** Tokens the MM is willing to quote in. Phase 1: USDC + WETH. */
  knownTokens: { usdc: TokenRef; weth: TokenRef };
  offerExpiryMs: number;
  settlementWindowMs: number;
}

export interface PreparedOffer {
  offer: Offer;
  deal: DealTerms;
  /** Outflow this offer commits us to (so the main loop can debit inventory
   *  on accept). */
  outflow: { token: keyof Inventory; amount: bigint };
  /** Phase 9: true when this offer covers less than the user's full
   *  intent amount because inventory wasn't deep enough. The wire-format
   *  Offer doesn't carry a `partial` flag; the User Agent detects it by
   *  comparing `offer.deal.amountA` to `intent.amount`. We surface it
   *  here for MM-side logging. */
  partial: boolean;
}

/** Decide whether to quote on `intent`, build a Deal, return the wire-form
 *  Offer + the Deal both parties will sign on-chain. `inventory` is the
 *  AVAILABLE inventory after subtracting the MM's reserve floor and any
 *  in-flight reservations from prior offers — the caller in `index.ts`
 *  applies both before invoking this function. `referenceTwap1e18` is
 *  the current Uniswap mid-price for the pair (USDC per WETH × 1e18),
 *  pulled from the synchronously-readable cache in `uniswap-reference.ts`.
 *  Both inventory accounting and reference staleness checks happen at
 *  the call site so this function stays sync + pure.
 *
 *  Phase 9: if `inventory` doesn't cover the full intent at the MM's
 *  spread, we now SIZE DOWN to whatever we can fill (returning a partial
 *  Offer) instead of declining. The wire-format Offer doesn't carry a
 *  `partial` flag — the User Agent detects partial-fill by comparing
 *  `offer.deal.amountA < intent.amount` (input-token wei). Only when
 *  the available inventory is effectively zero do we still return null
 *  (caller emits the existing Phase 8b decline message).
 */
export function buildOffer(
  intent: Intent,
  inventory: Inventory,
  referenceTwap1e18: bigint,
  cfg: NegotiatorConfig,
): PreparedOffer | null {
  const pair = pairFromIntent(intent, cfg);
  if (!pair) return null;

  const intentAmount = parseDecimal(intent.amount, pair.userInToken.decimals);
  const ourPrice = quote({ uniswap_twap: referenceTwap1e18, spread_bps: cfg.spreadBps });

  // Outflow token is what the MM gives out — the user's OUT token.
  const outflowToken: keyof Inventory = pair.userInIsWeth ? "usdc" : "weth";
  const outflowCeiling = maxOutflow(inventory, cfg.limits, outflowToken);
  if (outflowCeiling === 0n) return null; // nothing available — caller emits decline

  const sizing = sizeDeal({
    userInIsWeth: pair.userInIsWeth,
    amountIn: intentAmount,
    priceUsdcPerWeth1e18: ourPrice,
    usdcDecimals: cfg.knownTokens.usdc.decimals,
    wethDecimals: cfg.knownTokens.weth.decimals,
    maxOutflowB: outflowCeiling,
  });

  // Pathological case: ceiling so small the back-derived amountA rounds
  // to zero. Decline rather than emit a zero-amount offer.
  if (sizing.amountA === 0n || sizing.amountB === 0n) return null;

  const outflow = {
    token: outflowToken,
    amount: sizing.amountB,
  };
  // Defense-in-depth: sizing already respected the ceiling, so this should
  // always pass. Keeps the safety property explicit.
  if (!canFill(inventory, cfg.limits, outflow)) return null;

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
    price: formatPriceUsdcPerWeth(ourPrice),
    amount: amountHuman,
    expiry: deadline,
    settlement_window_ms: cfg.settlementWindowMs,
    deal,
    // EIP-712 sig over `deal`, populated by the caller via signDeal().
    signature: "0x",
  };

  return { offer, deal, outflow, partial: sizing.partial };
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
  userInToken: TokenRef;
  /** What we owe back to the user. */
  userOutToken: TokenRef;
  /** True iff userInToken is WETH. (Phase 1: only USDC + WETH supported.) */
  userInIsWeth: boolean;
}

function pairFromIntent(
  intent: Intent,
  cfg: NegotiatorConfig,
): PairResolution | null {
  const usdc = cfg.knownTokens.usdc;
  const weth = cfg.knownTokens.weth;
  const { base, quote: q } = intent;

  const baseIsUsdc = sameToken(base, usdc);
  const baseIsWeth = sameToken(base, weth);
  const quoteIsUsdc = sameToken(q, usdc);
  const quoteIsWeth = sameToken(q, weth);
  if (!((baseIsUsdc && quoteIsWeth) || (baseIsWeth && quoteIsUsdc))) return null;

  // intent.side === "sell": user sends `base`, wants `quote` back.
  // intent.side === "buy":  user wants `base`, sends `quote`.
  const userInToken = intent.side === "sell" ? base : q;
  const userOutToken = intent.side === "sell" ? q : base;
  return { userInToken, userOutToken, userInIsWeth: sameToken(userInToken, weth) };
}

function sameToken(a: TokenRef, b: TokenRef): boolean {
  return (
    a.chain_id === b.chain_id &&
    a.address.toLowerCase() === b.address.toLowerCase()
  );
}

function sizeDeal(opts: {
  userInIsWeth: boolean;
  amountIn: bigint;
  priceUsdcPerWeth1e18: bigint;
  usdcDecimals: number;
  wethDecimals: number;
  /** Phase 9: cap on amountB (the MM's outflow), in tokenB wei. When the
   *  forward-computed amountB would exceed this, both amountB and the
   *  back-derived amountA are scaled down to fit — yielding a partial
   *  offer rather than a decline. */
  maxOutflowB: bigint;
}): { amountA: bigint; amountB: bigint; partial: boolean } {
  const { userInIsWeth, amountIn, priceUsdcPerWeth1e18: price, maxOutflowB } = opts;
  const dDelta = BigInt(opts.wethDecimals - opts.usdcDecimals); // 12 for USDC(6)/WETH(18)
  const SCALE = 10n ** 18n;

  if (userInIsWeth) {
    // user gives WETH (18dp), MM owes USDC (6dp): amountB = amountIn * price / 1e18 / 10^dDelta
    let amountA = amountIn;
    let amountB = (amountA * price) / SCALE / 10n ** dDelta;
    let partial = false;
    if (amountB > maxOutflowB) {
      amountB = maxOutflowB;
      // Inverse of the forward formula: amountA = amountB * SCALE * 10^dDelta / price
      amountA = (amountB * SCALE * 10n ** dDelta) / price;
      partial = true;
    }
    return { amountA, amountB, partial };
  }
  // user gives USDC (6dp), MM owes WETH (18dp): amountB = amountIn * 1e18 * 10^dDelta / price
  let amountA = amountIn;
  let amountB = (amountA * SCALE * 10n ** dDelta) / price;
  let partial = false;
  if (amountB > maxOutflowB) {
    amountB = maxOutflowB;
    // Inverse of the forward formula: amountA = amountB * price / SCALE / 10^dDelta
    amountA = (amountB * price) / SCALE / 10n ** dDelta;
    partial = true;
  }
  return { amountA, amountB, partial };
}

function parseDecimal(human: string, decimals: number): bigint {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}

function formatPriceUsdcPerWeth(price1e18: bigint): string {
  const whole = price1e18 / 10n ** 18n;
  const frac = price1e18 % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
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
