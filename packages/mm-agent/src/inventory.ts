// Inventory accounting for the MM Agent.
//
// As of Phase 6, the MM consults on-chain `balanceOf` for the source of
// truth — there's no env-driven inventory cap, no in-memory mutable
// "remaining capacity". The chain says what we have; if a quote can't be
// honored, `lockMMSide` reverts and we drop the pending deal. SPEC §4.2 is
// satisfied without the operator having to keep `MM_INVENTORY_*` vars in
// sync with the wallet's actual balance.
//
// Optional `MM_MIN_USDC_RESERVE` / `MM_MIN_WETH_RESERVE` env vars (in
// human units, e.g. "100" = 100 USDC) let an operator hold something
// aside, but default to 0.

import { erc20Abi, type Address } from "viem";
import type { TokenRef } from "@parley/shared";

export interface Inventory {
  usdc: bigint;
  weth: bigint;
}

export interface InventoryLimits {
  min_usdc: bigint;
  min_weth: bigint;
}

export function canFill(
  inv: Inventory,
  limits: InventoryLimits,
  outflow: { token: keyof Inventory; amount: bigint },
): boolean {
  const remaining = inv[outflow.token] - outflow.amount;
  const min = outflow.token === "usdc" ? limits.min_usdc : limits.min_weth;
  return remaining >= min;
}

/** Phase 9: how much of the requested input the MM can actually fill,
 *  given live chain inventory minus the floor reserve. Returned in
 *  outflow-token wei (e.g., USDC wei when MM is selling USDC).
 *
 *  Caller is responsible for converting this back to input-token wei
 *  using the current price (see `negotiator.sizeDeal`).
 *
 *  Returns 0n when the MM has nothing above its reserve floor — the
 *  buildOffer caller treats this as "decline" and the existing Phase
 *  8b decline-message path fires.
 */
export function maxOutflow(
  inv: Inventory,
  limits: InventoryLimits,
  outflowToken: keyof Inventory,
): bigint {
  const min = outflowToken === "usdc" ? limits.min_usdc : limits.min_weth;
  const headroom = inv[outflowToken] - min;
  return headroom > 0n ? headroom : 0n;
}

/** Phase 9: subtract the sum of in-flight pending outflows from the chain
 *  balance to get "actually available" inventory. Without this, two
 *  concurrent intents from different users get quoted against the same
 *  chain balance and the MM over-commits.
 *
 *  Each `pending` entry has `outflow: { token, amount }` and a `state`.
 *  We exclude `recorded` (chain has already moved the funds, settled or
 *  refunded — no longer reserved by the MM). All other states (signed
 *  but not yet locked, locked but not yet settled, etc.) hold the MM
 *  on the hook and must be subtracted. */
export interface PendingOutflowSource {
  outflow: { token: keyof Inventory; amount: bigint };
  state: string;
  /** Unix seconds when the offer's deal.deadline expires. Once past,
   *  the offer can no longer be locked on-chain — we drop the
   *  reservation immediately so a follow-up intent isn't blocked by
   *  inventory that's effectively free again. */
  deadlineSec: number;
}

export function reservedOutflows(
  pending: Iterable<PendingOutflowSource>,
  nowSec: number = Math.floor(Date.now() / 1000),
): Inventory {
  const reserved: Inventory = { usdc: 0n, weth: 0n };
  for (const p of pending) {
    // Terminal — chain has already moved the funds.
    if (p.state === "recorded") continue;
    // Awaiting_accept past the deadline = dead. The next sweep will
    // GC it; we don't wait for the sweep to free up its reservation.
    if (p.state === "awaiting_accept" && p.deadlineSec <= nowSec) continue;
    reserved[p.outflow.token] += p.outflow.amount;
  }
  return reserved;
}

/** Subtract reserved-but-not-yet-settled outflows from the chain inventory
 *  snapshot. Floors at 0 so over-reserved inventory (which shouldn't
 *  happen, but might during a restart-recovery edge case) doesn't go
 *  negative. */
export function applyReservations(
  chain: Inventory,
  reserved: Inventory,
): Inventory {
  return {
    usdc: chain.usdc > reserved.usdc ? chain.usdc - reserved.usdc : 0n,
    weth: chain.weth > reserved.weth ? chain.weth - reserved.weth : 0n,
  };
}

interface ChainReader {
  readContract: (args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "balanceOf";
    args: [Address];
  }) => Promise<bigint>;
}

/** Read the MM's live ERC-20 balance for both quoted tokens. Called per-intent
 *  so quoting decisions reflect the wallet's actual state, not stale env
 *  config. Returns wei amounts. */
export async function fetchInventoryFromChain(
  publicClient: ChainReader,
  walletAddress: Address,
  knownTokens: { usdc: TokenRef; weth: TokenRef },
): Promise<Inventory> {
  const [usdc, weth] = await Promise.all([
    publicClient.readContract({
      address: knownTokens.usdc.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
    publicClient.readContract({
      address: knownTokens.weth.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
  ]);
  return { usdc, weth };
}

/** Optional reserve floors. Defaults to no reserve. Operator who wants to
 *  keep some balance aside (e.g., to manually rebalance later) can set
 *  `MM_MIN_USDC_RESERVE=100` to floor at 100 USDC. */
export function loadReserveLimitsFromEnv(opts: {
  usdcDecimals: number;
  wethDecimals: number;
}): InventoryLimits {
  const usdcRaw = process.env["MM_MIN_USDC_RESERVE"] ?? "0";
  const wethRaw = process.env["MM_MIN_WETH_RESERVE"] ?? "0";
  return {
    min_usdc: parseUnitsHuman(usdcRaw, opts.usdcDecimals),
    min_weth: parseUnitsHuman(wethRaw, opts.wethDecimals),
  };
}

function parseUnitsHuman(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}
