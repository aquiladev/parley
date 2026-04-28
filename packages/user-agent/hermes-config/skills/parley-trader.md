# Skill: parley-trader

Procedural memory for the Parley negotiation flow. Reusable patterns the agent should reach for when handling a trade. Read alongside SOUL.md.

## Negotiation loop

1. **Parse user intent** → structured `Intent` with `id` (UUID), `agent_id` (user wallet), `from_axl_pubkey` (read from `axl-mcp.get_topology`), side, base/quote, amount, slippage. Confirm terms via inline keyboard before broadcasting.
2. **Authorize** the intent — open `/authorize-intent?tid=<user>&intent=<JSON>` Mini App. Receive `{ auth, sig }` back. Store under `parley.current_intent_auth`.
3. **Broadcast** — call `axl-mcp.broadcast_intent` with intent + auth + auth_sig + session_binding + session_sig. On any reject reason from the §4.3 contract, handle per SOUL.md "Errors from privileged tools".
4. **Poll** — schedule `axl-mcp.poll_inbox()` at 2s cadence. Continue until `intent.timeout_ms` elapses or an acceptable offer arrives.
5. **Evaluate each `offer.quote`:**
   - Call `og-mcp.resolve_mm(offer.mm_ens_name)` (when known) to get the MM's verified `addr` and `axl_pubkey`. (Phase 2: hardcoded resolver; Phase 3: real ENS.)
   - Verify the offer's `signature` is a valid EIP-712 sig over `offer.deal` recovering to `offer.mm_agent_id`.
   - Verify `offer.deal.user` equals the user's wallet.
   - Call `og-mcp.read_mm_reputation(ens_name)` — drop offers below `policy.min_counterparty_rep`.
   - Compare against the Uniswap reference quote when available (Phase 5; Phase 2 just shows the offer's price).
6. **Surface the best surviving offer** with `[Accept] [Reject] [Details]`.

## On accept

1. Open `/sign?tid=<user>&deal=<URL-encoded DealTerms JSON>&offer_id=<id>` as a `web_app` button.
2. Wait for `web_app_data` of kind `lock_submitted`. The payload includes `txHash`, `deal_sig`, `accept_auth`, `accept_auth_sig`.
3. Construct the AXL `Accept` envelope: `{ type: "offer.accept", id: UUID, offer_id, user_agent_id, deal_hash, signature: deal_sig }`.
4. Call `axl-mcp.send_accept` with `to_peer_id` = MM's `axl_pubkey` (from the offer's `from_axl_pubkey` field, or `og-mcp.resolve_mm` resolution).

## After both lock events

1. Poll `Settlement.getState(dealHash)` (via a small `eth_call` you compose, or rely on the chain-watcher's `chain_event` logs surfaced by the sidecar). When state ≥ `BothLocked` (2):
2. Open `/settle?deal_hash=<hash>` as a `web_app` button.
3. Wait for `settled`. Confirm to user with the tx hash and a Sepolia Etherscan link.
4. (Phase 4) Call `og-mcp.write_trade_record` with the SessionBinding sig.

## Failure modes

- **Timeout, no acceptable offer** → Phase 5: prepare Uniswap fallback. Phase 2: report the timeout, end the negotiation.
- **MM never locks** → Phase 4: prompt `/refund` after `deadline + grace`. Phase 2: report the stuck deal.
- **Session expired mid-trade** → re-bind session via `/connect`, then resume from `parley.current_intent` and re-issue the next privileged tool call.
- **`SESSION_INVALID` / `INTENT_NOT_AUTHORIZED` / `MALFORMED_PAYLOAD` / `BINDING_MISMATCH`** → see SOUL.md.

## Conventions

- **Edit one status message** as the negotiation progresses. Use Hermes' message-edit primitive; do not send a new message per state transition.
- **Always include `tid`** in Mini App URLs so the typed-data signatures bake the right Telegram user id.
- **Display amounts** with token decimals when available. Wallet prompts show raw integers; your messages should show e.g. "50 USDC" not "50000000".
