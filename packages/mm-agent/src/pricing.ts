// Deterministic pricing — see SPEC §4.2.
// price = uniswap_twap * (1 + spread_bps / 10000)
//
// PHASE 1 SIMPLIFICATION: TWAP is hardcoded to a reference value. Real
// Uniswap v3 oracle reads land in Phase 4 polish (when ENS + reputation
// already work). The spread/inventory checks are the pieces that need to
// be real for Phase 1.
//
// The reference is expressed as base/quote scaled to 1e18 — for the
// USDC/WETH demo pair, that's "WETH price in USDC" times 1e18.

const PHASE1_REFERENCE_TWAP_USDC_PER_WETH_1E18 = 3000n * 10n ** 18n;

export interface PricingInput {
  uniswap_twap: bigint;
  spread_bps: number;
}

export function quote({ uniswap_twap, spread_bps }: PricingInput): bigint {
  return (uniswap_twap * BigInt(10000 + spread_bps)) / 10000n;
}

/** Phase 1 stub: returns a hardcoded TWAP for USDC/WETH on Sepolia.
 *  Replace with on-chain pool oracle reads in Phase 4. */
export function getReferenceTwap(): bigint {
  return PHASE1_REFERENCE_TWAP_USDC_PER_WETH_1E18;
}
