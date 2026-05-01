// Background Uniswap reference price refresher for MM pricing.
// SPEC §4.2 — replaces the Phase-1 hardcoded constant.
//
// Design (Phase 8, see ROADMAP.md):
//   1. setInterval-driven loop fetches Sepolia QuoterV2 mid-price for the
//      configured pair every `refreshIntervalMs`. Probes all standard v3
//      fee tiers and picks the best route (deepest pool wins on output).
//   2. Result is written to an in-memory cache keyed by (tokenIn, tokenOut)
//      with a `fetchedAt` timestamp.
//   3. The intent-handling path reads the cache SYNCHRONOUSLY — no await,
//      no RPC inline. Either we have a fresh cached price or we don't.
//   4. If `fetchedAt` is older than the caller's staleness threshold, the
//      caller is expected to DECLINE to quote rather than emit a stale
//      price. This module just reports age; the policy decision lives in
//      `index.ts` (the consumer).
//
// On RPC failure during a refresh tick we keep the prior cached value
// (last-good wins until the staleness threshold ages it out at the
// consumer side). consecutiveFailures is incremented for observability;
// past 5 we emit `price_refresh_chronic_failure` once at WARN level so
// operators can spot a sustained outage in `make logs-prod`.
//
// Intentional decisions:
//   - Probe size: 0.1 of tokenIn (i.e., 1e17 wei for 18-decimal WETH).
//     Small enough to minimize slippage on thin Sepolia pools (so the
//     quoted price approximates spot); large enough to avoid rounding
//     noise. The scaling formula handles any probe size correctly.
//   - Single pair, not multi-pair, for v1.0. Adding pairs is config-only
//     (the API is parameterized) but USDC/WETH is the only pair the MM
//     trades today; YAGNI on multi-pair until a second pair lands.
//   - interval.unref() so the process can exit cleanly on SIGTERM
//     without explicitly clearing the interval.

import { parseAbi, type Hex, type PublicClient } from "viem";

// Sepolia QuoterV2 address — same as og-mcp/src/uniswap.ts:74. Hardcoded
// because this module is Sepolia-only by design (per SPEC: "Target chain is
// Sepolia only"); a multi-chain version would source from a deployments map.
const SEPOLIA_QUOTER_V2: Hex = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";
const SEPOLIA_CHAIN_ID = 11155111;

// Standard Uniswap v3 fee tiers in 1e6 hundredths-of-a-bp:
// 100=0.01%, 500=0.05%, 3000=0.3%, 10000=1%.
const FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Probe with 1/10 of one full token unit. Small enough to avoid
// meaningful slippage on Sepolia pools, big enough to avoid rounding.
function probeAmountFor(decimalsIn: number): bigint {
  return 10n ** BigInt(decimalsIn) / 10n;
}

// Uniswap v3 fee tiers are denominated in hundredths of a basis point
// (1e6 == 100%). 3000 = 0.3%, 500 = 0.05%, etc. Used by stripPoolFee.
const FEE_DENOMINATOR = 1_000_000n;

/** Reverse the LP fee that QuoterV2's `amountOut` already deducted, so the
 *  MM's reference approximates the no-fee mid-price.
 *
 *  Why: QuoterV2 simulates a real swap — Uniswap v3 takes the fee off the
 *  input before the swap curve runs, so the returned `amountOut` is the
 *  fee-paying user's net. For peer-to-peer MM pricing the fee is
 *  irrelevant (no LP is involved); spreading off the fee-paid number
 *  would tilt the MM's quote by the fee tier each direction.
 *
 *  Math: `amountOut = curve(amountIn × (1 − fee/1e6))`. For small probes
 *  where the curve is locally linear, `amountOut_nofee ≈ amountOut /
 *  (1 − fee/1e6) = amountOut × 1e6 / (1e6 − fee)`. Exact in deep pools;
 *  sub-bps error in our 0.1 WETH probe on any Sepolia pool with usable
 *  liquidity. If sub-bps precision ever matters, switch to a direct
 *  `pool.slot0()` read of `sqrtPriceX96` for the true zero-trade mid.
 */
function stripPoolFee(amountOut: bigint, feeTier: number): bigint {
  return (amountOut * FEE_DENOMINATOR) / (FEE_DENOMINATOR - BigInt(feeTier));
}

const CHRONIC_FAILURE_THRESHOLD = 5;

export interface ReferencePair {
  /** tokenIn: the token whose price we're quoting (e.g., WETH). */
  tokenIn: Hex;
  /** tokenOut: the token we're quoting in (e.g., USDC). */
  tokenOut: Hex;
  decimalsIn: number;
  decimalsOut: number;
}

export interface ReferenceReading {
  /** Price expressed as `tokenOut natural units * 1e18` per 1 tokenIn. For
   *  the USDC/WETH pair this is "USDC per WETH * 1e18", matching the
   *  contract that `pricing.ts:quote()` already consumes. */
  value: bigint;
  /** Date.now() at the time of the successful fetch. */
  fetchedAt: number;
  /** Pool fee tier (1e6 hundredths-of-a-bp) of the route used. */
  feeTier: number;
}

export interface UniswapReference {
  /** Performs an initial fetch synchronously, then starts the background
   *  refresh loop. Resolves once the first fetch completes — successfully
   *  OR with a logged failure (caller proceeds either way; an empty cache
   *  causes downstream decline-to-quote, the right behavior). */
  start(): Promise<void>;
  /** Stop the background loop. Idempotent. */
  stop(): void;
  /** Synchronous in-memory cache read. Returns null when no value has been
   *  fetched yet (boot pre-warm failed and no subsequent refresh has
   *  succeeded). Caller is responsible for the staleness check via
   *  `fetchedAt` — this module deliberately doesn't enforce an age
   *  threshold so the policy stays at the consumer. */
  read(pair: ReferencePair): ReferenceReading | null;
}

export interface CreateUniswapReferenceArgs {
  client: PublicClient;
  chainId: number;
  /** Pair to track. Single pair for v1.0; trivially extendable to a list. */
  pair: ReferencePair;
  refreshIntervalMs: number;
  log: (obj: Record<string, unknown>) => void;
}

interface CacheEntry {
  value: bigint;
  fetchedAt: number;
  consecutiveFailures: number;
  feeTier: number;
}

interface BestRoute {
  amountOut: bigint;
  feeTier: number;
}

function pairKey(pair: ReferencePair): string {
  return `${pair.tokenIn.toLowerCase()}/${pair.tokenOut.toLowerCase()}`;
}

/** Convert a QuoterV2 amountOut for `probeIn` units of tokenIn into the
 *  `tokenOut natural units * 1e18 per 1 tokenIn natural unit` representation
 *  that pricing.ts expects.
 *
 *  Derivation: mid_price (in tokenOut wei per tokenIn wei) = amountOut / probeIn.
 *  Scaling that to "tokenOut units * 1e18 per 1 tokenIn unit":
 *    price_scaled_1e18 = (amountOut / probeIn) * 10^decimalsIn * 10^(18 - decimalsOut)
 *                      = amountOut * 10^(decimalsIn + 18 - decimalsOut) / probeIn
 *
 *  Always integer-division-safe for our pairs:
 *    USDC/WETH: 10^(18 + 18 - 6) / 1e17 = 10^30 / 10^17 = 10^13 — clean.
 */
function scaleToReference1e18(
  amountOut: bigint,
  probeIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
): bigint {
  const numeratorExp = decimalsIn + 18 - decimalsOut;
  if (numeratorExp >= 0) {
    return (amountOut * 10n ** BigInt(numeratorExp)) / probeIn;
  }
  // decimalsOut > decimalsIn + 18 — pathological, won't happen for any
  // ERC20 we care about; included so the function is total.
  return amountOut / (probeIn * 10n ** BigInt(-numeratorExp));
}

export function createUniswapReference(
  args: CreateUniswapReferenceArgs,
): UniswapReference {
  if (args.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `UniswapReference: unsupported chainId ${args.chainId} (Sepolia only — extend DEPLOYMENTS map for others)`,
    );
  }
  if (args.refreshIntervalMs < 1_000) {
    throw new Error(
      `UniswapReference: refreshIntervalMs must be >= 1000ms (got ${args.refreshIntervalMs})`,
    );
  }

  const cache = new Map<string, CacheEntry>();
  let interval: NodeJS.Timeout | null = null;
  let chronicLogged = false;

  async function findBestRoute(pair: ReferencePair): Promise<BestRoute | null> {
    const probeIn = probeAmountFor(pair.decimalsIn);
    const probes = await Promise.all(
      FEE_TIERS.map(async (fee) => {
        try {
          const sim = await args.client.simulateContract({
            address: SEPOLIA_QUOTER_V2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: pair.tokenIn,
                tokenOut: pair.tokenOut,
                amountIn: probeIn,
                fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
          // QuoterV2 returns a 4-tuple: (amountOut, sqrtPriceX96After,
          // initializedTicksCrossed, gasEstimate). We only need amountOut.
          const result = (sim as { result: readonly [bigint, bigint, number, bigint] })
            .result;
          return { feeTier: fee, amountOut: result[0] };
        } catch {
          // Pool doesn't exist at this fee tier (revert). Ignore; pick the
          // best of whatever quoted successfully across the other tiers.
          return null;
        }
      }),
    );
    let best: BestRoute | null = null;
    for (const p of probes) {
      if (p === null) continue;
      if (best === null || p.amountOut > best.amountOut) best = p;
    }
    return best;
  }

  async function refreshOnce(): Promise<void> {
    const k = pairKey(args.pair);
    const prev = cache.get(k);
    try {
      const best = await findBestRoute(args.pair);
      if (best === null) {
        const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
        if (prev) {
          cache.set(k, { ...prev, consecutiveFailures });
        }
        args.log({
          event: "price_refresh_failed",
          pair: k,
          reason: "no_pool_at_any_fee_tier",
          consecutive_failures: consecutiveFailures,
        });
        if (consecutiveFailures >= CHRONIC_FAILURE_THRESHOLD && !chronicLogged) {
          chronicLogged = true;
          args.log({
            event: "price_refresh_chronic_failure",
            pair: k,
            consecutive_failures: consecutiveFailures,
          });
        }
        return;
      }
      const probeIn = probeAmountFor(args.pair.decimalsIn);
      // Strip the LP fee BEFORE scaling — see stripPoolFee comment.
      const amountOutNoFee = stripPoolFee(best.amountOut, best.feeTier);
      const value = scaleToReference1e18(
        amountOutNoFee,
        probeIn,
        args.pair.decimalsIn,
        args.pair.decimalsOut,
      );
      cache.set(k, {
        value,
        fetchedAt: Date.now(),
        consecutiveFailures: 0,
        feeTier: best.feeTier,
      });
      chronicLogged = false; // reset after a successful refresh
      args.log({
        event: "price_refresh_ok",
        pair: k,
        value: value.toString(),
        amount_out_with_fee: best.amountOut.toString(),
        amount_out_no_fee: amountOutNoFee.toString(),
        fee_tier: best.feeTier,
      });
    } catch (err) {
      const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
      if (prev) {
        cache.set(k, { ...prev, consecutiveFailures });
      }
      args.log({
        event: "price_refresh_failed",
        pair: k,
        err: (err as Error).message,
        consecutive_failures: consecutiveFailures,
      });
      if (consecutiveFailures >= CHRONIC_FAILURE_THRESHOLD && !chronicLogged) {
        chronicLogged = true;
        args.log({
          event: "price_refresh_chronic_failure",
          pair: k,
          consecutive_failures: consecutiveFailures,
        });
      }
    }
  }

  return {
    async start(): Promise<void> {
      // First fetch synchronously so callers can await a warm cache.
      await refreshOnce();
      const initial = cache.get(pairKey(args.pair));
      if (initial) {
        args.log({
          event: "price_refresh_initial_ok",
          pair: pairKey(args.pair),
          value: initial.value.toString(),
          fee_tier: initial.feeTier,
        });
      } else {
        // Cache empty — RPC unreachable at boot. Don't throw; the consumer
        // will see read()=null and decline-to-quote, and the background
        // loop will keep retrying. Once the next tick succeeds, the MM
        // self-heals into a quoting state without a restart.
        args.log({
          event: "price_refresh_initial_failed",
          pair: pairKey(args.pair),
        });
      }

      // Background loop. unref() so the process can exit cleanly on
      // SIGTERM without an explicit clearInterval — the timer doesn't
      // pin the event loop alive.
      interval = setInterval(() => {
        refreshOnce().catch((err) => {
          args.log({
            event: "price_refresh_unhandled",
            err: (err as Error).message,
          });
        });
      }, args.refreshIntervalMs);
      interval.unref();
    },

    stop(): void {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },

    read(pair: ReferencePair): ReferenceReading | null {
      const c = cache.get(pairKey(pair));
      if (!c) return null;
      return { value: c.value, fetchedAt: c.fetchedAt, feeTier: c.feeTier };
    },
  };
}
