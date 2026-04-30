// Uniswap v3 helpers — SPEC §9.1 (fallback execution) + §9.2 (reference
// price). On-chain via QuoterV2 + SwapRouter02; no Trading API dependency.
//
// Why on-chain instead of the Trading API gateway:
//   - The Trading API doesn't index Sepolia (returns "No quotes available"
//     even for known-routable v3 pools like USDC/WETH). Mainnet works, but
//     our demo is Sepolia.
//   - QuoterV2 + SwapRouter02 are deployed on every chain Uniswap v3 ships
//     to, so the same code works mainnet + L2s + Sepolia.
//   - Avoids the Permit2 round-trip the Trading API requires for /v1/swap
//     (would need a multi-step bot ↔ Mini App orchestration).
//
// Both helpers fail open: on a network/contract error they return
// { ok: false, error: "..." } rather than throwing, so the bot can degrade
// gracefully (raw price, no fallback button).

import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";

/** Subset of the AXL Intent envelope this module needs. The full Intent
 *  carries signatures, AXL pubkeys, etc. that don't matter for Uniswap.
 *  `chain_id` on the TokenRef determines which chain we route on. */
export interface UniswapIntent {
  side: "buy" | "sell";
  base: { address: Hex; decimals: number; symbol: string; chain_id: number };
  quote: { address: Hex; decimals: number; symbol: string; chain_id: number };
  amount: string;
  max_slippage_bps: number;
}

/** Intent's base/quote are nominal pair labels — they don't tell us which
 *  side of the swap is the input. The `side` field does:
 *
 *    side === "sell": user gives `base`, receives `quote`. tokenIn=base,
 *                     tokenOut=quote, amount denominated in base.decimals.
 *    side === "buy":  user gives `quote`, receives `base`. tokenIn=quote,
 *                     tokenOut=base, amount denominated in quote.decimals.
 *
 *  The MM negotiator follows the same convention (see negotiator.ts
 *  pairFromIntent + sizeDeal). Without this resolution every Uniswap call
 *  would be in the wrong direction with the wrong decimals — silently
 *  returning a number that lines up unit-wise but represents the inverse
 *  trade. The "saves X% vs Uniswap" comparison then mixes peer-out and
 *  uniswap-out denominated in different tokens (apples vs oranges). */
function resolveDirection(intent: UniswapIntent): {
  tokenIn: UniswapIntent["base"];
  tokenOut: UniswapIntent["base"];
} {
  if (intent.side === "sell") {
    return { tokenIn: intent.base, tokenOut: intent.quote };
  }
  return { tokenIn: intent.quote, tokenOut: intent.base };
}

// Per-chain Uniswap v3 deployment addresses.
// Source: developers.uniswap.org/contracts/v3/reference/deployments
interface ChainDeployment {
  quoterV2: Hex;
  swapRouter02: Hex;
}
const DEPLOYMENTS: Record<number, ChainDeployment> = {
  1: {
    // Mainnet
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  },
  11155111: {
    // Sepolia
    quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  },
};

// Standard v3 fee tiers (in 1e6 hundredths-of-a-bp).
const FEE_TIERS: readonly number[] = [100, 500, 3000, 10000] as const;

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const SWAP_ROUTER_02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
]);

export interface PreparedFallbackSwap {
  to: Hex;
  data: Hex;
  /** Decimal string of wei. Stringified so it survives JSON transport. */
  value: string;
  /** Set when the user must approve a token to a spender (always SwapRouter02
   *  for v3 direct path) before the swap can execute. */
  approvalRequired?: { token: Hex; spender: Hex };
  /** Human-readable amounts for the offer card. */
  expectedInput: string;
  expectedOutput: string;
  /** Minimum acceptable output (decimal string, natural unit). Slippage
   *  protection applied per intent.max_slippage_bps. */
  minOutput: string;
  /** Pool fee tier picked for this route, in hundredths of a bp (3000 = 0.3%). */
  feeTier: number;
  /** "v3:USDC->WETH (0.3%)" style summary string for the bot UI. */
  route: string;
}

export interface UniswapQuoteResult {
  /** Output amount in the natural unit (decimal string), token = intent.base. */
  amountOut: string;
  /** Output amount in wei (decimal string), token = intent.base. */
  amountOutWei: string;
  /** Input amount in wei (decimal string), token = intent.quote. */
  amountInWei: string;
  /** Effective price = amountOut / amountIn (decimal string). */
  effectivePrice: string;
  /** Pool fee tier picked, in hundredths of a bp. */
  feeTier: number;
  route: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface BestRoute {
  amountOutWei: bigint;
  feeTier: number;
}

/** Probe every standard v3 fee tier for the pair, return the best route.
 *  A non-existent pool reverts; we ignore those and pick the best of
 *  whatever quoted successfully. */
async function findBestRoute(
  client: PublicClient,
  quoterAddress: Hex,
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
): Promise<BestRoute | null> {
  const probes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const result = (await client.simulateContract({
          address: quoterAddress,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })) as { result: readonly [bigint, bigint, number, bigint] };
        return { fee, amountOut: result.result[0] };
      } catch {
        return null;
      }
    }),
  );

  let best: BestRoute | null = null;
  for (const p of probes) {
    if (p === null) continue;
    if (best === null || p.amountOut > best.amountOutWei) {
      best = { amountOutWei: p.amountOut, feeTier: p.fee };
    }
  }
  return best;
}

function getDeployment(chainId: number): Result<ChainDeployment> {
  const dep = DEPLOYMENTS[chainId];
  if (!dep) {
    return {
      ok: false,
      error: `chainId ${chainId} not in DEPLOYMENTS; add the v3 addresses or pass a different chain`,
    };
  }
  return { ok: true, value: dep };
}

function getRpcUrl(): Result<string> {
  const url = process.env["SEPOLIA_RPC_URL"];
  if (!url || url === "") {
    return { ok: false, error: "SEPOLIA_RPC_URL is required for Uniswap v3 quoter calls" };
  }
  return { ok: true, value: url };
}

function buildClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl) });
}

/**
 * Build calldata for a Uniswap v3 fallback swap. Picks the best fee tier
 * via on-chain QuoterV2, then encodes a SwapRouter02.exactInputSingle call
 * with `amountOutMinimum` derived from the intent's slippage tolerance.
 *
 * The Mini App consumes the returned struct: optional `approve()` first
 * (if not already approved to SwapRouter02), then `sendTransaction({ to, data, value })`.
 */
export async function prepareFallbackSwap(
  intent: UniswapIntent,
  userAddress: Hex,
): Promise<Result<PreparedFallbackSwap>> {
  try {
    const { tokenIn, tokenOut } = resolveDirection(intent);
    const chainId = tokenIn.chain_id;
    const dep = getDeployment(chainId);
    if (!dep.ok) return dep;
    const rpc = getRpcUrl();
    if (!rpc.ok) return rpc;
    const client = buildClient(rpc.value);

    const amountInWei = parseUnits(intent.amount, tokenIn.decimals);

    const best = await findBestRoute(
      client,
      dep.value.quoterV2,
      tokenIn.address,
      tokenOut.address,
      amountInWei,
    );
    if (best === null) {
      return {
        ok: false,
        error: `no v3 pool found for ${tokenIn.symbol}->${tokenOut.symbol} on chain ${chainId}`,
      };
    }

    // Apply slippage: amountOutMinimum = expected * (1 - slippage_bps/10000).
    const slippageBps = BigInt(intent.max_slippage_bps);
    const amountOutMinimumWei =
      (best.amountOutWei * (10_000n - slippageBps)) / 10_000n;

    // Deadline doesn't need to be in the Uniswap call (SwapRouter02's
    // exactInputSingle does not take one — it's only on the older v3-periphery
    // SwapRouter). We rely on the user's wallet expiring stale txs naturally.

    const data = encodeFunctionData({
      abi: SWAP_ROUTER_02_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          fee: best.feeTier,
          recipient: userAddress,
          amountIn: amountInWei,
          amountOutMinimum: amountOutMinimumWei,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const value: PreparedFallbackSwap = {
      to: dep.value.swapRouter02,
      data,
      value: "0",
      approvalRequired: {
        token: tokenIn.address,
        spender: dep.value.swapRouter02,
      },
      expectedInput: intent.amount,
      expectedOutput: formatUnitsDecimal(best.amountOutWei, tokenOut.decimals),
      minOutput: formatUnitsDecimal(amountOutMinimumWei, tokenOut.decimals),
      feeTier: best.feeTier,
      route: `v3:${tokenIn.symbol}->${tokenOut.symbol} (${formatFeeTier(best.feeTier)})`,
    };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Reference-price helper. On-chain QuoterV2 only; no calldata-build step.
 * Cheaper than `prepareFallbackSwap` and used during offer evaluation
 * to compute "saves X% vs Uniswap". Same routing logic, no transaction
 * encoding.
 */
export async function getUniswapQuote(
  intent: UniswapIntent,
  // Kept in the signature so SOUL.md's `swapper: session_binding.wallet`
  // pattern carries over unchanged from the Trading-API era. Unused for
  // QuoterV2 (the read doesn't care who's swapping).
  _swapper: Hex,
): Promise<Result<UniswapQuoteResult>> {
  try {
    const { tokenIn, tokenOut } = resolveDirection(intent);
    const chainId = tokenIn.chain_id;
    const dep = getDeployment(chainId);
    if (!dep.ok) return dep;
    const rpc = getRpcUrl();
    if (!rpc.ok) return rpc;
    const client = buildClient(rpc.value);

    const amountInWei = parseUnits(intent.amount, tokenIn.decimals);

    const best = await findBestRoute(
      client,
      dep.value.quoterV2,
      tokenIn.address,
      tokenOut.address,
      amountInWei,
    );
    if (best === null) {
      return {
        ok: false,
        error: `no v3 pool found for ${tokenIn.symbol}->${tokenOut.symbol} on chain ${chainId}`,
      };
    }

    const amountOut = formatUnitsDecimal(best.amountOutWei, tokenOut.decimals);
    const effectivePrice =
      best.amountOutWei === 0n
        ? "0"
        : divDecimal(
            best.amountOutWei,
            amountInWei,
            tokenOut.decimals,
            tokenIn.decimals,
          );

    return {
      ok: true,
      value: {
        amountOut,
        amountOutWei: best.amountOutWei.toString(),
        amountInWei: amountInWei.toString(),
        effectivePrice,
        feeTier: best.feeTier,
        route: `v3:${tokenIn.symbol}->${tokenOut.symbol} (${formatFeeTier(best.feeTier)})`,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Compute savings basis-points: positive = peer beats Uniswap.
 * Returns a signed integer (bps), e.g. 40 = "0.4% better than Uniswap."
 */
export function computeSavingsBps(
  peerAmountOutWei: bigint,
  uniswapAmountOutWei: bigint,
): number {
  if (uniswapAmountOutWei === 0n) return 0;
  const num = (peerAmountOutWei - uniswapAmountOutWei) * 10000n;
  const bps = num / uniswapAmountOutWei;
  if (bps > 1_000_000n) return 1_000_000;
  if (bps < -1_000_000n) return -1_000_000;
  return Number(bps);
}

// ---- helpers ---------------------------------------------------------------

function formatFeeTier(fee: number): string {
  // Uniswap v3 fees are in hundredths of a bp: 3000 = 0.30%, 500 = 0.05%.
  const pct = fee / 10_000;
  return `${pct.toFixed(2)}%`;
}

/** Format a wei amount as a decimal string in the natural unit. */
function formatUnitsDecimal(wei: bigint, decimals: number): string {
  if (decimals === 0) return wei.toString();
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const div = 10n ** BigInt(decimals);
  const whole = abs / div;
  const frac = abs % div;
  if (frac === 0n) return (negative ? "-" : "") + whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + "." + fracStr;
}

/** Divide two wei amounts and produce a decimal string with reasonable
 *  precision. Used for the effective-price ratio. */
function divDecimal(
  numWei: bigint,
  denWei: bigint,
  numDecimals: number,
  denDecimals: number,
): string {
  if (denWei === 0n) return "0";
  const SCALE = 18;
  const scaled =
    (numWei * 10n ** BigInt(SCALE + denDecimals)) /
    (denWei * 10n ** BigInt(numDecimals));
  return formatUnitsDecimal(scaled, SCALE);
}
