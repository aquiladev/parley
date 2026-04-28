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

/** Load inventory from env. Values in env are human-readable (e.g.
 *  `MM_INVENTORY_USDC=10000` = 10,000 USDC), converted to wei here using
 *  the configured token decimals. */
export function loadInventoryFromEnv(opts: {
  usdcDecimals: number;
  wethDecimals: number;
  minUsdcReserveBps?: number; // basis points of starting balance to keep aside
  minWethReserveBps?: number;
}): { inventory: Inventory; limits: InventoryLimits } {
  const usdcRaw = process.env["MM_INVENTORY_USDC"] ?? "0";
  const wethRaw = process.env["MM_INVENTORY_WETH"] ?? "0";

  const usdc = parseUnitsHuman(usdcRaw, opts.usdcDecimals);
  const weth = parseUnitsHuman(wethRaw, opts.wethDecimals);

  const usdcBps = opts.minUsdcReserveBps ?? 0;
  const wethBps = opts.minWethReserveBps ?? 0;

  return {
    inventory: { usdc, weth },
    limits: {
      min_usdc: (usdc * BigInt(usdcBps)) / 10000n,
      min_weth: (weth * BigInt(wethBps)) / 10000n,
    },
  };
}

function parseUnitsHuman(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}
