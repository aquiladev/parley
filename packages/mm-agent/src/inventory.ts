// Inventory accounting for the MM Agent.
//
// As of Phase 6, the MM consults on-chain `balanceOf` for the source of
// truth — there's no env-driven inventory cap, no in-memory mutable
// "remaining capacity". The chain says what we have; if a quote can't be
// honored, `lockMMSide` reverts and we drop the pending deal. SPEC §4.2 is
// satisfied without the operator having to keep `MM_INVENTORY_*` vars in
// sync with the wallet's actual balance.
//
// Phase 9 added per-intent reservation: pending offers that haven't yet
// settled subtract their outflow from the chain inventory before the
// next offer is sized, so concurrent intents can't double-spend the
// same balance.
//
// Phase 10 generalizes from the hardcoded {usdc, weth} shape to an
// address-keyed Map<Hex, bigint>. The MM operator configures supported
// tokens via MM_TOKEN_ADDRESSES (see token-registry.ts); inventory
// helpers now work for any token in the registry.
//
// Optional `MM_MIN_<SYMBOL>_RESERVE` env vars (in human units, e.g.
// "100" = 100 USDC) let an operator hold something aside, defaulting
// to 0.

import { erc20Abi, type Address, type Hex } from "viem";
import type { SupportedToken } from "./token-registry.js";

/** Token-balance map keyed by lowercase address. Address keys are
 *  enforced lowercase by all helpers below — pass any case in, get the
 *  right answer out. Operator code that constructs Inventory directly
 *  must lowercase the key. */
export type Inventory = Map<Hex, bigint>;

/** Reserve floor per token, address-keyed (lowercase). */
export type InventoryLimits = Map<Hex, bigint>;

const lc = (s: string): Hex => s.toLowerCase() as Hex;

function get(map: Map<Hex, bigint>, addr: Hex): bigint {
  return map.get(lc(addr)) ?? 0n;
}

export function canFill(
  inv: Inventory,
  limits: InventoryLimits,
  outflow: { token: Hex; amount: bigint },
): boolean {
  const remaining = get(inv, outflow.token) - outflow.amount;
  const min = get(limits, outflow.token);
  return remaining >= min;
}

/** How much of `outflowToken` the MM can actually pay out, given
 *  available inventory (already net of pending reservations) minus the
 *  reserve floor. Returns 0n when there's nothing to give. */
export function maxOutflow(
  inv: Inventory,
  limits: InventoryLimits,
  outflowToken: Hex,
): bigint {
  const headroom = get(inv, outflowToken) - get(limits, outflowToken);
  return headroom > 0n ? headroom : 0n;
}

export interface PendingOutflowSource {
  outflow: { token: Hex; amount: bigint };
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
  const reserved: Inventory = new Map();
  for (const p of pending) {
    if (p.state === "recorded") continue;
    if (p.state === "awaiting_accept" && p.deadlineSec <= nowSec) continue;
    const key = lc(p.outflow.token);
    reserved.set(key, (reserved.get(key) ?? 0n) + p.outflow.amount);
  }
  return reserved;
}

/** Subtract reserved outflows from the chain inventory snapshot.
 *  Floors at 0 per token so over-reserved positions don't go negative
 *  (which shouldn't happen, but might during a restart-recovery edge). */
export function applyReservations(
  chain: Inventory,
  reserved: Inventory,
): Inventory {
  const out: Inventory = new Map(chain);
  for (const [token, amt] of reserved) {
    const have = out.get(token) ?? 0n;
    out.set(token, have > amt ? have - amt : 0n);
  }
  return out;
}

interface ChainReader {
  readContract: (args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "balanceOf";
    args: [Address];
  }) => Promise<bigint>;
}

/** Read the MM's live ERC-20 balance for every token in the registry.
 *  Called per-intent so quoting decisions reflect the wallet's actual
 *  state, not a stale env config. Returns wei amounts keyed by
 *  lowercase address. */
export async function fetchInventoryFromChain(
  publicClient: ChainReader,
  walletAddress: Address,
  tokens: readonly SupportedToken[],
): Promise<Inventory> {
  const reads = await Promise.all(
    tokens.map(async (t) => ({
      addr: t.address,
      bal: await publicClient.readContract({
        address: t.address as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
      }),
    })),
  );
  const out: Inventory = new Map();
  for (const r of reads) out.set(lc(r.addr), r.bal);
  return out;
}

/** Optional reserve floors. Defaults to 0 per token. Operator who wants
 *  to keep some balance aside (e.g., to manually rebalance later) can
 *  set `MM_MIN_<SYMBOL>_RESERVE=100` per supported token. */
export function loadReserveLimitsFromEnv(
  tokens: readonly SupportedToken[],
): InventoryLimits {
  const out: InventoryLimits = new Map();
  for (const t of tokens) {
    const envKey = `MM_MIN_${t.symbol.toUpperCase()}_RESERVE`;
    const raw = process.env[envKey] ?? "0";
    out.set(lc(t.address), parseUnitsHuman(raw, t.decimals));
  }
  return out;
}

function parseUnitsHuman(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (trimmed === "" || trimmed === "0") return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}
