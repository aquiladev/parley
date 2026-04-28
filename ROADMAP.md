# Parley — Implementation Roadmap

**Companion document to:** `PARLEY_SPEC.md` (v1.2)
**Goal:** turn the spec into a working demo end-to-end.
**Estimate:** 13–16 days of one-developer work.

This document sequences the build. It is operational, not architectural — for the protocol design itself, see the spec. Items here exist because they're needed to *get to a working demo*, not because they're features of the protocol.

---

## How to read this document

The build is broken into six phases. Each phase ends with a **demoable state** — a concrete thing you can show another developer and verify works end-to-end before moving on. Phases are sequential; each builds on the previous.

Within a phase, items are listed as outcomes, not tasks. Outcomes are what makes the phase complete; tasks are what you do to get there. If a phase is taking longer than estimated, the right move is to break specific outcomes into checklists, not to push outcomes into later phases.

**Sequencing principles:**
1. **Risky integrations first.** Hit external dependencies (Hermes, AXL, 0G Compute, WalletConnect) on day 1, not day 8. Discovering a broken integration on day 5 is much worse than discovering it on day 1.
2. **Happy path before edge cases.** Get one trade flowing end-to-end with hardcoded values before adding policy enforcement, retries, or robustness layers.
3. **Architecture before identity.** Settlement spine is the load-bearing part of the system. Prove that works before layering on ENS, reputation, and the rest of the identity machinery.
4. **Real chain before optimization.** Settle real Sepolia transactions early; layer fancier behavior on top.

**Tester readiness:** each phase has an annotation indicating who the build state is appropriate for. The progression is: developer-only → trusted testers → invited testers → open. The earliest point where the system reflects what the spec actually claims is Phase 4 (reputation working).

---

## Phase 0 — Environment and reachability

**Estimate:** 1 day
**Tester readiness:** developer only — no functioning system yet, just credentials

**Goal:** every external service the spec depends on is reachable from a fresh checkout, with the credentials and accounts needed.

**Outcomes:**

- [x] Sepolia RPC endpoint reachable; three Sepolia-funded test wallets created (the user persona's wallet, the MM Agent's hot wallet, and the `parley.eth` parent wallet for ENS operations later)
- [x] AXL Go binary built locally; `/topology` returns peer info on a single node
- [x] Two AXL nodes hub-and-spoke configuration: each can `/send` to the other and `/recv` returns the message — proves transport works at the protocol level
- [x] 0G Compute account provisioned, prepaid balance funded, hello-world inference call returns text via the OpenAI-compatible client
- [x] 0G Storage SDK uploads a sample blob and downloads it back; Merkle proof verifies — establishes the SDK works for the eventual reputation flow
- [x] `parley.eth` (or chosen alternative) registered on Sepolia ENS via `sepolia.app.ens.domains`. Just registration; no subnames or text records yet.
- [x] Uniswap Trading API key obtained from `developers.uniswap.org/dashboard`; sample `/quote` call returns a price for USDC/WETH on Sepolia
- [x] WalletConnect project ID obtained; basic browser connect-flow tested with a mobile MetaMask

**Demoable state:** every external dependency works in isolation, tested individually. No code yet, just credentials, configs, and proofs in a checkable form (screenshots, transaction hashes, logs).

**Why this phase exists:** most build problems trace back to "we discovered on day 5 that the API doesn't actually do what we assumed." Doing this on day 1 collapses those failure modes early and cheaply.

---

## Phase 1 — Settlement spine, no ENS, no Hermes

**Estimate:** 3 days
**Tester readiness:** developer only — terminal-only, no UX

**Goal:** a single peer-matched trade flows through the entire architecture, from intent to settled, with all values hardcoded. No policy, no LLM, no Telegram, no Mini App, no ENS, no reputation.

**Outcomes:**

- [x] `Settlement.sol` written and deployed to Sepolia. Foundry tests cover the lock-lock-settle path and the lock-then-refund path. EIP-712 typehash verified.
- [x] MM Agent skeleton: TypeScript daemon with hardcoded inventory and spread, AXL listener using the polling pattern, deterministic pricing (`uniswap_twap * (1 + spread_bps/10000)`), EIP-712 signing of `Deal` typed data, direct `viem` submission of `lockMMSide` from a faucet-funded hot wallet
- [x] User Agent skeleton: a Node.js script (not Hermes) that broadcasts a hardcoded intent over AXL, evaluates the first offer it receives, and signs `lockUserSide` using a script-controlled EOA private key — *this is a Phase 1 shortcut and gets removed in Phase 2*
- [x] Peer discovery is hardcoded via `KNOWN_MM_AXL_PUBKEYS` env var. No ENS resolution. No `og-mcp.resolve_mm` call.
- [x] One trade settles end-to-end. Both parties' balances change as expected. `Settled` event observable on Sepolia.

**Demoable state:** terminal-only demo. Run two processes (User Agent script and MM Agent daemon), watch logs, see "trade settled, here's the tx hash." Not pretty, but the architectural spine is proven.

**Why this phase is structured this way:** Phase 1 has a lot of risk concentrated in it — Settlement.sol, AXL transport, EIP-712 signing, viem submission patterns, and the integration of all of them. Pulling ENS and 0G out keeps the risk surface manageable. **Plan for the spec to be wrong in at least one place** during this phase; every implementation pass surfaces something the design didn't account for.

**The Phase 1 hack, called out explicitly:** the user side signs with a script-controlled private key for this phase only. This is wrong from a trust-model perspective and gets removed in Phase 2 — but it lets us prove the lock-lock-settle logic works without coupling it to the user-facing surface. Marking the script with a `// PHASE 1 ONLY — REMOVE IN PHASE 2` comment is mandatory.

---

## Phase 2 — User-facing surface, still no ENS

**Estimate:** 3–4 days
**Tester readiness:** developer + 1–2 trusted testers (you on your phone, plus maybe one collaborator)

**Goal:** replace the hardcoded user side with the real user-facing flow. Telegram bot, Mini App, WalletConnect, real wallet signing. Peer discovery still hardcoded. ENS still stubbed.

**Outcomes:**

- [x] Hermes Agent installed and configured. Basic Telegram bot replies to messages using **Claude API** as the LLM backend (per the spec's documented fallback). 0G Compute is deferred to Phase 4: its auth model uses per-request signed headers rather than a static API key, so it can't talk to Hermes directly without a local broker-wrapping proxy. See `zg_compute_findings` memory. Per-user session memory works (verified by manual multi-user test). *(multi-user verification deferred to pre-demo gate; see deployment.md §8)*
- [x] Custom MCPs implemented:
  - [x] `axl-mcp` — `discover_peers`, `broadcast_intent`, `send_offer`, `send_accept`, `poll_inbox`, `get_topology`
  - [x] `og-mcp` — `resolve_mm` (returns from a hardcoded map keyed by ENS name; same return shape it'll have post-Phase-3), `read_mm_reputation` (returns neutral score 0.0 for now), `read_user_reputation` (returns neutral)
- [x] All four privileged-tool validation checks implemented and tested in `axl-mcp.broadcast_intent` and `axl-mcp.send_accept`: session signature, action signature, payload schema, Telegram-binding consistency
- [x] AXL listener sidecar bridges incoming offers into Hermes' inbox via Strategy A (polling). Strategy B verified or deferred to roadmap. *(Strategy B deferred to Phase 4; Hermes' own scheduled `axl-mcp.poll_inbox` is the bridge; sidecar provides observability + chain-watcher)*
- [x] Mini App `/connect` route: WalletConnect → wallet signs session-binding EIP-712 → returns to bot. Round-trip verified on real iOS device with real MetaMask Mobile.
- [x] Mini App `/sign` route: signs `Deal` typed data, then immediately submits `lockUserSide(deal, sig)` from user's wallet via `wagmi.writeContract`, then returns tx hash to bot. Also collects `AcceptAuthorization` sig (§4.3) and adds `/authorize-intent` + `/settle` routes for the full action-sig flow.
- [x] User Agent state machine implemented: NEW → AWAITING_WALLET_CONNECT → READY → EXPIRED. Per-user state in Hermes memory.
- [x] Phase 1's script-signed user side is removed. The real user, holding a real wallet, drives everything from the user side.

**Demoable state:** real user (you, on your phone) opens Telegram, types "swap 50 USDC for ETH", connects wallet via Mini App, signs and settles a real trade with the MM Agent from Phase 1. End-to-end with real human-in-the-loop authorization.

**Honest caveat:** the demo at this point lies about ENS. The MM appears in offer cards as `mm-1.parley.eth` but that name doesn't exist on-chain yet — it's hardcoded in `og-mcp.resolve_mm`. This is fine for developer testing but **not appropriate for external testers**, because the offer card claims something the system doesn't actually do.

---

## Phase 3 — ENS integration

**Estimate:** 2 days
**Tester readiness:** developer + small invited group (the demo finally matches what the spec claims)

**Goal:** replace the hardcoded ENS resolution with real on-chain resolution. MM Agents are real ENS subnames.

**Outcomes:**

- [x] MM registration script (`packages/user-agent/scripts/register-mm.ts`; spec said `packages/contracts/scripts/` but contracts is Foundry-only — script lives where the existing Phase-N scripts do). Exercised on Sepolia: `mm-1.parley.eth` is registered with `addr`, `axl_pubkey`, `agent_capabilities` text records set. `reputation_root` deliberately not set yet — Phase 4 sets it after the first trade rather than initializing to a placeholder.
- [x] `og-mcp.resolve_mm` body replaced with real `viem`-based ENS resolution. The hardcoded map fallback is removed; unknown names return `isError: true` with a structured error code, no quiet fallback.
- [x] User Agent's `axl-mcp.discover_peers()` reads `KNOWN_MM_ENS_NAMES` env var and resolves each in parallel via `viem.getEnsAddress` + `getEnsText("axl_pubkey")`, returning `{ens_name, addr, axl_pubkey}` per peer (same shape as Phase 2). Names that fail to resolve are surfaced with an `error` field rather than dropped silently. `KNOWN_MM_AXL_PUBKEYS` env var dropped — derived from ENS now.
- [x] Verification on offer arrival exercises real ENS data: `X-From-Peer-Id` matches the resolved `axl_pubkey` text record; EIP-712 signature on deal terms matches the resolved `addr`. Both checks pass against the real chain. *(Verification logic lives in Hermes' SOUL.md per §4.4; the resolver provides the data.)*
- [x] Telegram offer card displays the real ENS name (which now exists on-chain). *(`Offer.mm_ens_name` field added to `@parley/shared`; MM Agent populates from `MM_ENS_NAME` env.)*
- [ ] Optional: `/register <handle>` opt-in user flow if there's spare time. Implementation is the same shape as the MM registration script but invoked from the bot/Mini App. Likely better as a Phase 5 polish item. *(Deferred to Phase 5 polish per the original roadmap note.)*

**Demoable state:** the system architecturally matches the spec. An external observer auditing the system would find that the offer card's `mm-1.parley.eth` resolves on-chain, the verification checks are real, and the discovery mechanism is what's documented.

**Why ENS gets its own phase:** ENS resolution is its own integration risk surface — the Sepolia ENS Manager UI, NameWrapper transactions, `viem.getEnsAddress`/`getEnsText` semantics, parallel resolution latency. Bundling it into Phase 1 (as an earlier draft of this roadmap did) would have inflated Phase 1's risk. Bundling it into Phase 2 would have entangled it with the user-facing surface, which has its own integration risks (WalletConnect on iOS, Mini App round-trips). Splitting it out makes both Phase 2 and Phase 3 smaller and more focused.

---

## Phase 4 — Reputation, robustness, observability

**Estimate:** 3 days
**Tester readiness:** Sepolia open beta — first point where reputation, refunds, and observability all work; the system is honest about its claims

**Goal:** the demo works reliably, not just in the happy path. Reputation actually accrues. Refunds work. Logs make debugging possible.

**Outcomes:**

- [ ] After each settled trade, both parties write a `TradeRecord` blob to 0G Storage via `og-mcp.write_trade_record`. Records are keyed by both wallets (for users) and by ENS name (for MMs).
- [ ] MM Agent updates its own `text("reputation_root")` ENS record after each trade (pointing to the new index blob in 0G).
- [ ] `og-mcp.read_mm_reputation` and `og-mcp.read_user_reputation` implement the scoring formula from §7.3 of the spec. Aggregate score is visible in offer cards.
- [ ] Refund flow: user accepts → MM never locks → deadline passes → user can submit `refund(dealHash)` from the Mini App. Tested end-to-end with a deliberately stalled MM.
- [ ] Settle-side flow: once both lock events are observed, the User Agent prompts the user to submit `settle(dealHash)` from the Mini App. By convention this is the user-side path; the MM Agent has it as a fallback if the user's session expires.
- [ ] ERC-20 approval flow: first time a user trades a token, the Mini App detects the missing approval and runs an approval submission as a discrete step before the lock. Same applies to Permit2 approval for Uniswap fallback (Phase 5).
- [ ] Failure recovery in onboarding: signature timeout, wallet mismatch (connected `0xA` but signed from `0xB`), session expiry mid-trade. Each has a clear bot-side message and recovery path.
- [ ] Per-user policy fields (`min_counterparty_rep`, `max_slippage_bps`, `timeout_ms`) stored in Hermes memory, scoped per Telegram user ID. Editable via `/policy`.
- [ ] Chain-watcher subroutine inside the AXL sidecar subscribes to Settlement contract events (`UserLocked`, `MMLocked`, `Settled`, `Refunded`) and injects state changes into Hermes' inbox. Replaces any earlier polling-based event detection.
- [ ] Structured logging across User Agent, MM Agent, and Mini App. Every state transition timestamped with relevant context. JSON format for grep-ability.
- [ ] **0G Compute proxy** (deferred from Phase 2): a small local service that wraps `@0glabs/0g-serving-broker`, exposes an OpenAI-compatible `/v1/chat/completions` endpoint to Hermes, and generates per-request signed headers transparently. Until shipped, Hermes runs on Claude API as primary. See `zg_compute_findings` memory.

**Demoable state:** a small group of invited testers can use Parley on their own phones, with their own funded wallets. Trades complete. Refunds work. Reputation visibly accrues across multiple trades. When something goes wrong, the logs say what.

---

## Phase 5 — Uniswap fallback and polish

**Estimate:** 2–3 days
**Tester readiness:** Sepolia open access — the system the spec actually describes

**Goal:** the fallback path works visibly, the savings story is anchored to a real number, the surface looks intentional.

**Outcomes:**

- [ ] `prepareFallbackSwap` builds Uniswap calldata via `/check_approval` → `/quote` → `/swap` (the implementation from §9.1 of the spec).
- [ ] Mini App `/swap` route: handles Permit2 approval (if needed) then submits the swap from the user's wallet via `wagmi.sendTransaction`. Returns tx hash to bot.
- [ ] Reference price comparison: every peer offer shown to the user includes a "vs Uniswap" delta computed from the same `/quote` endpoint that powers fallback. The "saved 0.6% vs Uniswap" beat is anchored to a real measured number.
- [ ] User Agent triggers fallback after `timeout_ms` with no acceptable offer (or all offers below `max_slippage_bps`). User is prompted to submit the fallback swap; if they decline, the intent expires.
- [ ] Mini App polish: handle picker UI for the optional `/register` path (if not already in Phase 3), proper loading states, clear error messages on tx failures.
- [ ] Bot polish: `/help`, `/policy`, `/balance`, `/history`, `/logout`, `/reset` commands all work and return useful output. `/register <handle>` and `/unregister` if not already shipped.
- [ ] Optional `/register` opt-in user flow shipped, if Phase 3 didn't already cover it.

**Demoable state:** the demo Aquila would actually want to show another person. Fallback works visibly. Numbers tell a real "saved X% vs Uniswap" story. The bot conversation feels intentional, not stitched together. Onboarding takes ~30 seconds for a wallet-ready user.

---

## Risk register

Things that could derail the build, with mitigations. Listed in approximate order of "this is the one I'd be most worried about."

### High-risk

**Hermes session isolation might not work as the spec assumes.** The spec assumes a single Hermes process can hold per-Telegram-user state with strict isolation between users. If Hermes' session model doesn't actually support this — or if it has bugs — multi-tenant operation breaks. *Mitigation:* verify on Day 1 of Phase 2 with a deliberate two-user test (two Telegram accounts, two different wallets, simultaneous sessions). If isolation is broken, fall back to per-user processes managed by a supervisor (heavier ops, but works).

**0G Compute function-calling might be unreliable.** Hermes generates function-call shapes via the LLM. If 0G Compute's hosted models don't reliably produce well-formed function calls (a known weakness in some open-source models), tool calls degrade and the agent stops working correctly. *Mitigation:* during Phase 0 inference smoke test, exercise function-calling specifically. If unreliable, fall back to Claude API behind the same OpenAI-compatible interface and revisit 0G Compute later.

**WalletConnect on iOS might have deep-link issues.** Telegram → Mini App → MetaMask deep link → return to Telegram is a multi-app round-trip with several places to fail. *Mitigation:* test on real iOS device on Day 1 of Phase 2. If broken, fall back to manual "switch back to Telegram" instruction screen with clear text. Lose some UX polish, retain function.

### Medium-risk

**AXL `/recv` polling might have higher latency than the spec assumes.** Spec assumes <2s latency for offer delivery; if the Go binary's polling loop has hidden delays, negotiation feels slow. *Mitigation:* measure during Phase 1, then either tighten the polling interval or implement Strategy B (sidecar event injection) as a parallel path.

**Sepolia RPC reliability.** Free public Sepolia RPCs are known to flake. Transaction submission failures on Sepolia would be misleading (looks like a code bug, actually infrastructure). *Mitigation:* use a paid RPC provider (Alchemy, Infura, QuickNode free tier is usually sufficient) from Phase 0 onward. Don't rely on `https://rpc.sepolia.org` for any demoable state.

**ENS subgraph indexer lag on Sepolia.** When the registration script mints a subname, ENS resolution may have a delay before the new subname is queryable via reverse lookup. *Mitigation:* in Phase 3, build with the assumption that resolution is eventually consistent (poll a few times before giving up). If reverse-resolution is too lagged, prefer the local `wallet → subname` index that the User Agent maintains.

### Low-risk (but worth naming)

**Foundry test coverage may miss settlement edge cases.** Coverage gaps are normal but can hide griefing vectors. *Mitigation:* explicitly write tests for the deadline-edge cases (block.timestamp == deadline, deadline+1, refund-after-settle prevention).

**0G Storage indexer availability.** Free testnet indexer might rate-limit or have downtime. *Mitigation:* don't query 0G in latency-critical paths; reputation reads happen during offer evaluation which already has a few-second window. If it flakes, fall back to neutral score.

**Telegram bot rate limits.** Telegram has per-bot rate limits that get aggressive under heavy use. *Mitigation:* use message editing rather than new messages for live status updates (the spec already specifies this pattern); implement basic backoff if 429s appear.

---

## What's deliberately not in this roadmap

Items the spec mentions but that aren't required for a working demo:

- **Two competing MM Agents.** One MM proves the architecture works; two is a richer-demo polish item, not a build requirement. Add only if Phase 5 has spare time.
- **Optional user ENS registration (`/register <handle>`).** The protocol works without it; opt-in registration is a Phase 5 polish item at most.
- **Cross-wallet reputation portability via opt-in user ENS.** Same reasoning.
- **Encrypted reputation history.** Important for mainnet privacy; not needed for the testnet demo. See spec §11.
- **EIP-7702 session keys, fuses-locked subname migration, Agentic ID, cross-chain settlement, multi-round negotiation, partial fills, dispute resolution, account abstraction, Confidential VM deployment, e-commerce gateway, pay-with-any-token.** All in spec §11. None required for a working demo.

A demo doesn't need every spec'd feature — it needs the spine of the architecture working end-to-end with at least one path through every major integration. Everything else is iteration.

---

## How this document evolves

The roadmap will be wrong somewhere. Specs describe steady states; build plans describe transitions, and transitions surface things steady-state thinking misses. When that happens:

- **Estimate is off** → adjust the affected phase's estimate, note what was underestimated. Don't push outcomes into later phases just to hit the original number.
- **An outcome is missing** → add it to the appropriate phase. If it's significant, note when it was added and why.
- **A phase boundary is wrong** → restructure honestly. Six phases is a recommendation, not a contract.
- **The spec is wrong** → update the spec, not just the build plan. The spec is the source of truth for design; the build plan is the source of truth for sequence.

This is a working document, not a finished one.