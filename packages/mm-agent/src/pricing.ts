// Deterministic pricing — see SPEC §4.2.
// price = uniswap_twap * (1 + spread_bps / 10000)
//
// No CEX feeds, no IL modeling, no hedging. Adding any of those is a
// roadmap item (§11.4), not a v1.0 change.

export interface PricingInput {
  uniswap_twap: bigint; // raw on-chain price, scaled to 1e18 base/quote
  spread_bps: number;   // operator-configured edge
}

export function quote({ uniswap_twap, spread_bps }: PricingInput): bigint {
  // (twap * (10000 + spread)) / 10000, integer math to avoid float drift.
  return (uniswap_twap * BigInt(10000 + spread_bps)) / 10000n;
}
