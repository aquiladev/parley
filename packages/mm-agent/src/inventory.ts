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
