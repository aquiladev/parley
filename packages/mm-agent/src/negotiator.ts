// Quote signing, accept handling, settlement submission. SPEC §4.2, §5.3.
// All EIP-712 signing happens here with the MM hot wallet via viem.

import { randomUUID } from "node:crypto";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DealTerms, Intent, Offer, TokenRef } from "@parley/shared";

import { canFill, type Inventory, type InventoryLimits } from "./inventory.js";
import { dealForSigning, dealHash, DEAL_TYPES } from "./eip712.js";
import { getReferenceTwap, quote } from "./pricing.js";
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
  inventory: Inventory;
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
}

/** Decide whether to quote on `intent`, build a Deal, return the wire-form
 *  Offer + the Deal both parties will sign on-chain. */
export function buildOffer(
  intent: Intent,
  cfg: NegotiatorConfig,
): PreparedOffer | null {
  const pair = pairFromIntent(intent, cfg);
  if (!pair) return null;

  const intentAmount = parseDecimal(intent.amount, pair.userInToken.decimals);
  const refTwap = getReferenceTwap();
  const ourPrice = quote({ uniswap_twap: refTwap, spread_bps: cfg.spreadBps });

  const sizing = sizeDeal({
    userInIsWeth: pair.userInIsWeth,
    amountIn: intentAmount,
    priceUsdcPerWeth1e18: ourPrice,
    usdcDecimals: cfg.knownTokens.usdc.decimals,
    wethDecimals: cfg.knownTokens.weth.decimals,
  });

  const outflow = {
    token: pair.userInIsWeth ? ("usdc" as const) : ("weth" as const),
    amount: sizing.amountB,
  };
  if (!canFill(cfg.inventory, cfg.limits, outflow)) return null;

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

  const offer: Offer = {
    type: "offer.quote",
    id: randomUUID(),
    intent_id: intent.id,
    mm_agent_id: cfg.mmAddress,
    price: formatPriceUsdcPerWeth(ourPrice),
    amount: intent.amount,
    expiry: deadline,
    settlement_window_ms: cfg.settlementWindowMs,
    deal,
    // EIP-712 sig over `deal`, populated by the caller via signDeal().
    signature: "0x",
  };

  return { offer, deal, outflow };
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
}): { amountA: bigint; amountB: bigint } {
  const { userInIsWeth, amountIn, priceUsdcPerWeth1e18: price } = opts;
  const dDelta = BigInt(opts.wethDecimals - opts.usdcDecimals); // 12 for USDC(6)/WETH(18)
  const SCALE = 10n ** 18n;

  if (userInIsWeth) {
    // user gives WETH (18dp), MM owes USDC (6dp): amountB = amountIn * price / 1e18 / 10^dDelta
    const amountB = (amountIn * price) / SCALE / 10n ** dDelta;
    return { amountA: amountIn, amountB };
  }
  // user gives USDC (6dp), MM owes WETH (18dp): amountB = amountIn * 1e18 * 10^dDelta / price
  const amountB = (amountIn * SCALE * 10n ** dDelta) / price;
  return { amountA: amountIn, amountB };
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

function nonceFromIntent(intentId: string): bigint {
  // Deterministic nonce per intent id so retries don't collide. Phase 4
  // should swap this for a (user, mm) monotonic counter.
  let h = 0n;
  for (let i = 0; i < intentId.length; i++) {
    h = ((h << 5n) - h + BigInt(intentId.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  return h === 0n ? 1n : h;
}
