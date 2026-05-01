// Deterministic pricing — see SPEC §4.2.
// price = uniswap_twap * (1 + spread_bps / 10000)
//
// Phase 8: the reference price is no longer a hardcoded constant. It flows
// in from the caller (see `uniswap-reference.ts`, instantiated in
// `index.ts` and read synchronously inside `handleIntent`). The MM
// background-refreshes a Uniswap v3 QuoterV2 mid-price for the configured
// pair every `MM_PRICE_REFRESH_INTERVAL_MS` and declines to quote if the
// cached value is older than `MM_PRICE_MAX_STALE_MS`. This file's only
// remaining responsibility is the pure spread-application formula — kept
// deliberately small and side-effect-free.
//
// Reference is expressed as base/quote scaled to 1e18 — for the USDC/WETH
// demo pair, that's "USDC per WETH" times 1e18.

export interface PricingInput {
  uniswap_twap: bigint;
  spread_bps: number;
}

export function quote({ uniswap_twap, spread_bps }: PricingInput): bigint {
  return (uniswap_twap * BigInt(10000 + spread_bps)) / 10000n;
}
