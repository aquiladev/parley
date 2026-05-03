// Background Uniswap reference price refresher for MM pricing.
// SPEC §4.2 — replaces the Phase-1 hardcoded constant.
//
// Phase 8: single-pair (USDC/WETH) reference, refreshed every N seconds
//          via Sepolia QuoterV2. Synchronous read at quote time.
// Phase 9: fee-strip on the QuoterV2 output so the cached value is the
//          no-fee mid (not the post-LP-fee output).
// Phase 10: multi-pair, per-direction cache. The MM operator configures
//           N pairs in `MM_SUPPORTED_PAIRS`; this module refreshes a
//           cache entry for EACH direction (`tokenIn → tokenOut` and
//           `tokenOut → tokenIn`). Cache is keyed by `(tokenIn, tokenOut)`
//           with the price expressed as `tokenOut natural units per 1
//           tokenIn natural unit, scaled to 1e18`. Per-direction caching
//           (rather than caching one direction and inverting) avoids
//           bigint division precision loss on inverse rates.
//
// Resilience model: on RPC failure during a refresh tick we keep the
// prior cached value (last-good wins until age-out). After 5 consecutive
// failures across the WHOLE refresher we emit `price_refresh_chronic_failure`
// once at WARN level. Each refresh cycle iterates all configured
// directions in parallel; one direction's failure doesn't poison the others.
//
// Probe size: 0.1 of one tokenIn natural unit (small enough to avoid
// meaningful slippage on Sepolia pools, big enough to avoid rounding
// noise). Same as Phase 8.

import { parseAbi, type Hex, type PublicClient } from "viem";

const SEPOLIA_QUOTER_V2: Hex = "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3";
const SEPOLIA_CHAIN_ID = 11155111;

const FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

function probeAmountFor(decimalsIn: number): bigint {
  return 10n ** BigInt(decimalsIn) / 10n;
}

const FEE_DENOMINATOR = 1_000_000n;

/** Reverse the LP fee that QuoterV2's amountOut already deducted, so the
 *  cached value is the no-fee mid. See Phase 9 commit for the math
 *  derivation; this is the same helper. */
function stripPoolFee(amountOut: bigint, feeTier: number): bigint {
  return (amountOut * FEE_DENOMINATOR) / (FEE_DENOMINATOR - BigInt(feeTier));
}

const CHRONIC_FAILURE_THRESHOLD = 5;

export interface ReferencePair {
  tokenIn: Hex;
  tokenOut: Hex;
  decimalsIn: number;
  decimalsOut: number;
}

export interface ReferenceReading {
  /** tokenOut natural units per 1 tokenIn natural unit, scaled to 1e18. */
  value: bigint;
  /** Date.now() at the time of the successful fetch. */
  fetchedAt: number;
  /** Pool fee tier (1e6 hundredths-of-a-bp) of the route used. */
  feeTier: number;
}

export interface UniswapReference {
  start(): Promise<void>;
  stop(): void;
  /** Synchronous in-memory cache read, keyed by (tokenIn, tokenOut). */
  read(pair: ReferencePair): ReferenceReading | null;
}

export interface CreateUniswapReferenceArgs {
  client: PublicClient;
  chainId: number;
  /** Phase 10: list of directions to keep priced. Each direction is one
   *  (tokenIn, tokenOut) probe and one cache entry. The MM Agent passes
   *  `registry.listDirections()` here. */
  directions: readonly ReferencePair[];
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

function pairKey(p: { tokenIn: Hex; tokenOut: Hex }): string {
  return `${p.tokenIn.toLowerCase()}/${p.tokenOut.toLowerCase()}`;
}

/** Convert a QuoterV2 amountOut for `probeIn` units of tokenIn into the
 *  `tokenOut natural units × 1e18 per 1 tokenIn natural unit` representation
 *  the MM consumes. See Phase 8 commit for derivation; pair-agnostic.
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
  return amountOut / (probeIn * 10n ** BigInt(-numeratorExp));
}

export function createUniswapReference(
  args: CreateUniswapReferenceArgs,
): UniswapReference {
  if (args.chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `UniswapReference: unsupported chainId ${args.chainId} (Sepolia only)`,
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
          const result = (sim as { result: readonly [bigint, bigint, number, bigint] })
            .result;
          return { feeTier: fee, amountOut: result[0] };
        } catch {
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

  async function refreshOne(pair: ReferencePair): Promise<boolean> {
    const k = pairKey(pair);
    const prev = cache.get(k);
    try {
      const best = await findBestRoute(pair);
      if (best === null) {
        const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
        if (prev) cache.set(k, { ...prev, consecutiveFailures });
        args.log({
          event: "price_refresh_failed",
          pair: k,
          reason: "no_pool_at_any_fee_tier",
          consecutive_failures: consecutiveFailures,
        });
        return false;
      }
      const probeIn = probeAmountFor(pair.decimalsIn);
      const noFee = stripPoolFee(best.amountOut, best.feeTier);
      const value = scaleToReference1e18(
        noFee,
        probeIn,
        pair.decimalsIn,
        pair.decimalsOut,
      );
      cache.set(k, {
        value,
        fetchedAt: Date.now(),
        consecutiveFailures: 0,
        feeTier: best.feeTier,
      });
      args.log({
        event: "price_refresh_ok",
        pair: k,
        value: value.toString(),
        amount_out_with_fee: best.amountOut.toString(),
        amount_out_no_fee: noFee.toString(),
        fee_tier: best.feeTier,
      });
      return true;
    } catch (err) {
      const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
      if (prev) cache.set(k, { ...prev, consecutiveFailures });
      args.log({
        event: "price_refresh_failed",
        pair: k,
        err: (err as Error).message,
        consecutive_failures: consecutiveFailures,
      });
      return false;
    }
  }

  async function refreshAll(): Promise<void> {
    // Fan out across all configured directions in parallel; each pair is
    // independent so one failure doesn't poison the others.
    const results = await Promise.all(args.directions.map(refreshOne));
    const okCount = results.filter(Boolean).length;
    const failCount = results.length - okCount;
    // Emit a single chronic-failure log when ALL directions have been
    // failing repeatedly. Avoids per-pair noise; one alert per chronic
    // window.
    const chronicCount = Array.from(cache.values()).filter(
      (e) => e.consecutiveFailures >= CHRONIC_FAILURE_THRESHOLD,
    ).length;
    if (chronicCount === args.directions.length && !chronicLogged) {
      chronicLogged = true;
      args.log({
        event: "price_refresh_chronic_failure",
        directions: args.directions.length,
        ok: okCount,
        fail: failCount,
      });
    } else if (okCount > 0) {
      // Any successful refresh resets the chronic flag.
      chronicLogged = false;
    }
  }

  return {
    async start(): Promise<void> {
      if (args.directions.length === 0) {
        args.log({ event: "price_refresh_no_directions_configured" });
      } else {
        await refreshAll();
        const initialOk = Array.from(cache.values()).filter(
          (e) => e.consecutiveFailures === 0,
        ).length;
        args.log({
          event: "price_refresh_initial",
          directions: args.directions.length,
          ok: initialOk,
        });
      }
      interval = setInterval(() => {
        refreshAll().catch((err) => {
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
