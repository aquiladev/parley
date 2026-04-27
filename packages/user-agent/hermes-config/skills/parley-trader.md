# Skill: parley-trader

Procedural memory for the Parley negotiation flow. Reusable patterns the agent should reach for when handling a trade.

## Negotiation loop

1. Parse user intent → structured `Intent`. Confirm terms via inline keyboard before broadcasting.
2. Open the Mini App for the user to sign the `Intent` payload (EIP-712).
3. Call `axl-mcp.broadcast_intent(...)` with the signature.
4. Schedule `axl-mcp.poll_inbox()` at ~2s cadence until `timeout_ms` elapses or an acceptable offer arrives.
5. For each incoming `offer.quote`:
   - Resolve sender via `og-mcp.resolve_mm(ens_name)`.
   - Verify AXL `X-From-Peer-Id` matches resolved `axl_pubkey`.
   - Verify EIP-712 deal-terms signature recovers to resolved `addr`.
   - `og-mcp.read_mm_reputation(ens_name)` — drop if below `min_counterparty_rep`.
   - Compare against cached Uniswap reference quote — drop if `savingsBps < 0`.
6. Surface the best surviving offer with `[Accept] [Reject] [Details]`.
7. On accept: open Mini App's `/sign` flow with prepared `lockUserSide` calldata.
8. After both lock events observed via the chain-watcher, prompt `/settle`.
9. On `Settled`: call `og-mcp.write_trade_record(...)` and report success.

## Failure modes

- **Timeout, no acceptable offer** → prepare Uniswap fallback via `prepareFallbackSwap`, surface `/swap` flow.
- **MM never locks** → after `deadline`, prompt `/refund` flow.
- **Session expired mid-trade** → re-bind session, then resume from the held context.
