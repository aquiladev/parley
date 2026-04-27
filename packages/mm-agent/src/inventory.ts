// Static inventory tracking. SPEC §4.2.
// No rebalancing in v1.0. Reject intents that exceed available balance or
// that would push reserves below configured minimums.

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
