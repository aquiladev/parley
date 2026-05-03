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

- [x] After each settled trade, both parties write a `TradeRecord` blob to 0G Storage via `og-mcp.write_trade_record` (user side) / direct SDK upload + ENS publish (MM side). Records keyed by wallet (users) and ENS name (MMs).
- [x] MM Agent updates its own `text("reputation_root")` ENS record after each trade (pointing to the new index blob in 0G). `mm-1.parley.eth` ownership transferred to `MM_EVM` so the MM can self-publish.
- [x] `og-mcp.read_mm_reputation` and `og-mcp.read_user_reputation` implement the §7.3 scoring formula. MM reads follow the canonical ENS path (`reputation_root` → index blob → records); user reads use og-mcp's local index. Smoke test verifies the math against the spec's worked examples.
- [x] Refund flow: `/refund` Mini App route submits `refund(dealHash)` from the user's wallet; SOUL.md describes the bot-side prompt path when `getState` reports a stuck `UserLocked` past deadline.
- [x] Settle-side flow: already shipped in Phase 2's `/settle` route; SOUL.md now ties it to the post-trade record write.
- [x] ERC-20 approval flow: `/sign` checks `allowance(user, settlement)` on mount; renders an "Approve" step before the sign+lock if it's insufficient.
- [x] Failure recovery in onboarding: SOUL.md "Failure modes — recovery flows" covers signature timeout, wallet mismatch, session expiry mid-trade, and the four privileged-tool error reasons.
- [x] Per-user policy fields (`min_counterparty_rep`, `max_slippage_bps`, `timeout_ms`) stored in Hermes memory; `/policy` command spec in SOUL.md.
- [x] Chain-watcher subroutine inside the AXL sidecar subscribes to Settlement events. *(Already shipped in Phase 2 — `getContractEvents` polling because public Sepolia RPC drops `eth_newFilter` handles; revert to `watchContractEvent` once on a paid RPC. See `sepolia_rpc_filter_quirk` memory.)*
- [x] Structured logging across User Agent, MM Agent, and Mini App. MM Agent + sidecar emit JSON logs; MCPs use stderr (non-blocking — their stdout is reserved for MCP protocol).
- [ ] **0G Compute proxy** (deferred from Phase 2; still pending): a small local service that wraps `@0glabs/0g-serving-broker`, exposes an OpenAI-compatible `/v1/chat/completions` endpoint to Hermes, and generates per-request signed headers transparently. Until shipped, Hermes runs on Claude API as primary. See `zg_compute_findings` memory. *(Decided: defer to Phase 5 polish — Claude API is working fine and a proxy without real demand is premature.)*

**Demoable state:** a small group of invited testers can use Parley on their own phones, with their own funded wallets. Trades complete. Refunds work. Reputation visibly accrues across multiple trades. When something goes wrong, the logs say what.

---

## Phase 5 — Uniswap fallback and polish

**Estimate:** 2–3 days
**Tester readiness:** Sepolia open access — the system the spec actually describes

**Goal:** the fallback path works visibly, the savings story is anchored to a real number, the surface looks intentional.

**Outcomes:**

- [x] `prepareFallbackSwap` builds Uniswap v3 calldata directly: probes QuoterV2 across standard fee tiers (100/500/3000/10000), picks the best route, encodes a `SwapRouter02.exactInputSingle` call with slippage-protected `amountOutMinimum`. Lives at `packages/user-agent/mcps/og-mcp/src/uniswap.ts`. **Note: pivoted from the Trading API approach in §9.1 because Uniswap's gateway doesn't index Sepolia v3 pools** — same architectural goal, on-chain implementation. SPEC.md §9.1 left as an alternate-path reference; the canonical implementation is on-chain.
- [x] Mini App `/swap` route: handles ERC-20 approval to SwapRouter02 (if needed) then submits the swap from the user's wallet via `wagmi.sendTransaction`. Returns tx hash to bot.
- [x] Reference price comparison: `og-mcp.get_uniswap_reference_quote` reads QuoterV2 on-chain so SOUL.md's offer-evaluation step can surface "saves 0.X% vs Uniswap" against a real number.
- [x] User Agent triggers fallback after `timeout_ms` with no acceptable offer. SOUL.md "Timeout, no acceptable offer" recovery flow now drives the live `/swap` button (no peer-system TradeRecord — fallback is unrelated to peer rep).
- [x] Mini App polish: shared `formatTxError` helper distinguishes wallet-rejection / allowance / RPC / revert errors across all routes (`lib/tx-error.ts`).
- [x] Bot polish: `/help`, `/policy`, `/balance`, `/history`, `/logout`, `/reset` specced in SOUL.md "Other commands (Phase 5)".
- [x] Token migration: real Sepolia USDC (`0x1c7D…7238`) / WETH (`0xfFf9…6B14`) now drive both peer trades and fallback. MM Agent boot-fails with funding hints if the hot wallet is under-inventoried (real tokens have no `mint()`). Phase-1 TestERC20 contracts archived.
- [ ] Optional `/register` opt-in user flow → **deferred to long-term backlog** (cross-wallet rep portability isn't load-bearing for the demo; revisit when an external tester asks).

**Demoable state:** the demo Aquila would actually want to show another person. Fallback works visibly. Numbers tell a real "saved X% vs Uniswap" story. The bot conversation feels intentional, not stitched together. Onboarding takes ~30 seconds for a wallet-ready user.

---

## Phase 6 — Containerized deployment
 
**Estimate:** 4–6 days, split across two sub-phases (local Docker validation, then single-VPS deployment)
**Tester readiness:** Sepolia open access — same as Phase 5, but now self-hostable rather than tethered to a developer's laptop
 
**Goal:** convert the Phase-5 demo from "works on the developer's machine" to "deploys reproducibly on a server." Three Dockerfiles, a `compose.yml`, the operational hygiene to run unattended.
 
This phase is grounded in `deployment.md`, the working document that tracks deployment shape, environment variables, persistent state, build pipeline, networking, and external configuration. Phase 6 turns that document's open items into committed artifacts.
 
### Phase 6a — Local Docker validation (2–3 days)
 
**Goal:** the entire stack runs end-to-end on the developer's laptop using `docker compose up`. No remote server involved yet — this sub-phase exists specifically to surface containerization issues without conflating them with VPS-deployment issues.
 
**Outcomes:**
 
- [x] Three `Dockerfile`s in the repo (under `infra/`):
  - **User Agent image** (`infra/Dockerfile.user-agent`) — Python 3.11 slim base + Node 24 + Hermes pinned to v0.11.0 via the upstream `install.sh` (curl | bash). Multi-stage: golang AXL builder + node TS builder + python+node runtime. `supervisord` runs AXL node + AXL sidecar + `hermes gateway run`.
  - **MM Agent image** (`infra/Dockerfile.mm-agent`) — Node 24 slim base + AXL Go binary + compiled mm-agent. `tini` PID 1 + bash entrypoint runs AXL in background and mm-agent in foreground.
  - **Mini App image** (`infra/Dockerfile.miniapp`) — Node 24 slim base + `.next/standalone` server bundle. `NEXT_PUBLIC_*` baked via `--build-arg` per `deployment.md` §4.
- [x] A `compose.yml` that starts all three services with explicit `depends_on: condition: service_healthy` and healthchecks. Order-of-start follows `deployment.md` §7 (mm-agent waits for user-agent).
- [x] `.env.example` aligned with `deployment.md` §2. The single root-level `.env` is mounted via `env_file:` into each container (never `COPY`'d into images). Per-service `environment:` overrides null out secrets each service shouldn't see (defense in depth).
- [x] Volume mounts for the persistent state per `deployment.md` §3: each agent's `axl.pem` is bind-mounted from `infra/state/<agent>/axl.pem`; Hermes' `~/.hermes/` is a named volume `parley_hermes_state`; SOUL.md + skills are COPY'd into the image and the entrypoint syncs them into `~/.hermes/` on start.
- [x] Per-service healthchecks: `wget /topology` against AXL's HTTP API on port 9002 (agents); HTTP GET / for the Mini App.
- [x] Logo asset sync (`pnpm -F @parley/miniapp sync-assets`) is a required step in `infra/Dockerfile.miniapp`'s builder stage — skipping it ships stale icons; the Dockerfile makes this explicit, not implicit.
- [x] `make deploy-local` (in the root `Makefile`) generates AXL identities, builds all three images, and brings the stack up with one invocation.
- [x] Hermes packaging committed: bake-install at v0.11.0 (override via `--build-arg HERMES_VERSION=...`). Documented inline in `infra/Dockerfile.user-agent`.

**Verification before moving to 6b:**

- [x] All three containers come up healthy on `docker compose up` — verified locally, all three reach `(healthy)` within ~30s.
- [ ] A real Telegram message round-trips through to Hermes and back — pending live exercise (needs Mini App tunnel + Telegram setup; not blocking 6a).
- [x] The Mini App is reachable on `localhost:3000` and serves the connect/sign/swap routes (HTTP 200, all 11 routes prerendered).
- [ ] A trade settles end-to-end (User Agent → MM Agent → Settlement → 0G Storage write) entirely inside the local Docker stack — pending live exercise; same gate as the Telegram round-trip.
- [ ] Volume restart test: `docker compose down && docker compose up` preserves Hermes session bindings and AXL identities — easy to verify once the Telegram round-trip lands; volume + bind-mount config is in place to support it.
**Demoable state (6a):** Parley running locally on a single laptop via `docker compose up`. Same demo as Phase 5, now reproducible on any machine with Docker installed.
 
### Phase 6b — Single-VPS deployment (2–3 days)
 
**Goal:** the stack runs on a remote server, addressable via a stable HTTPS hostname for the Mini App, with the operational substrate in place to keep it running unattended.
 
**Outcomes:**

- [x] Stable HTTPS hostname for the Mini App, fronted by an existing Traefik instance with automatic Let's Encrypt TLS. Standalone `compose.prod.yml` (Traefik labels + external network attachment, no host port bindings). The hostname is added to:
  - [x] WalletConnect Cloud's project domain allowlist (verified — wallet connection succeeds in prod)
  - [x] Telegram BotFather (`/setdomain` and the `web_app` URL on the bot's menu button)
- [x] AXL nodes configured to reach existing public Gensyn AXL peers (the user-agent and both MM nodes peer with `34.46.48.224` and `136.111.135.206` per `infra/axl/node-config.*.json`).
- [x] ENS subnames registered on Sepolia: `mm-1.parley.eth` and `mm-2.parley.eth` are both live with `addr`, `axl_pubkey`, and `agent_capabilities` text records (Phase 7 work).
- [ ] Multi-user isolation verified under realistic load: two test Telegram accounts simultaneously, distinct sessions, no context leakage. This is the gate before opening the bot to anyone outside the team — see `deployment.md` §8.
- [ ] Hermes pairing re-enabled in production (or `TELEGRAM_ALLOWED_USERS` curated explicitly). The dev-time `GATEWAY_ALLOW_ALL_USERS=true` setting is reversed.
- [ ] The external-configuration runbook from `deployment.md` §6 walked through deliberately: WalletConnect allowlist ✓, BotFather setup ✓, bot avatar uploaded, ENS records confirmed ✓, Sepolia funding for both MM hot wallets ✓, GitHub social preview image set.
- [ ] Backups in place for the truly non-recreatable state: all three `axl.pem` files (user-agent, mm-agent, mm-agent-2) and the deployer wallet private keys, stored cold and externally to the host.
- [ ] Rotation runbooks drafted (not necessarily exercised) for: `MM_EVM_PRIVATE_KEY` (drain → redeploy with new key → update ENS `addr` → restart) and `axl.pem` (new key → re-register `axl_pubkey` text record → restart).
- [ ] NTP confirmed running on the host. EIP-712 deadlines depend on accurate clocks.
- [x] Logging committed to a destination — JSON to stdout reachable via `make logs-prod` / `docker compose -f compose.prod.yml logs`. Aggregator deferred.

**Phase 6b infrastructure shipped during the deploy that wasn't in the original outcome list:**

- [x] Permission shim for `infra/state/*/axl.pem`: macOS Docker Desktop transparently remaps host UIDs, but Linux preserves them — so the operator must `sudo chown -R 10001:10001 infra/state/` once after `make axl-keys` so the bind-mounted PEMs are readable by the container's `parley` user (uid 10001). Documented in deployment runbook.
- [x] Wallet-side Sepolia RPC URL wired through the miniapp build (`NEXT_PUBLIC_SEPOLIA_RPC_URL`): without this, viem's wagmi transport falls back to a public Sepolia default, rate-limits, and surfaces "Network or RPC error" on every `lockUserSide` confirmation. Now baked into the miniapp client bundle from the same paid endpoint the agents use.

**Verification before declaring 6b complete:**

- [x] The bot is reachable on Telegram via its production handle
- [x] The Mini App loads at the production HTTPS hostname
- [x] A trade completes end-to-end with the developer's own wallet, on the deployed instance (verified after the wagmi RPC fix landed)
- [ ] Two test Telegram users, simultaneous sessions, isolation holds (no context leakage between sessions) — the security gate before opening to outside testers
- [ ] `docker compose restart user-agent` preserves all in-flight state
**Demoable state (6b):** Parley running on a server, addressable by anyone with the bot's Telegram handle. Self-hostable. Operationally honest — backups, monitoring, isolation verified.
 
### What Phase 6 deliberately does not do
 
- **Does not add CI/CD.** Push-to-deploy is a separate operational maturity step. Phase 6 leaves deploy as a manual `make deploy` invocation triggered from the developer's machine. CI/CD is on the post-Phase-7 backlog.
- **Does not add metrics dashboards.** Logs to `docker logs` are the floor; an aggregated dashboard is welcome but explicitly out of scope. Phase 6 is "self-hostable," not "production-grade observability."
- **Does not split User Agent and MM Agent across hosts.** Single VPS, all containers (four after Phase 7: user-agent, mm-agent, mm-agent-2, miniapp). The split-deployment posture is a future operational concern.
- **Does not handle protocol upgrades / rolling restarts.** A `docker compose restart user-agent` will drop in-flight Mini App signing flows. Mitigating that requires session-state persistence beyond what's specced. Out of scope for Phase 6; on the operational-maturity backlog.
---
 
## Phase 7 — Second MM Agent and competitive offer cards
 
**Estimate:** 1–2 days
**Tester readiness:** same as Phase 6 — but the demo now visibly shows what Parley actually is
 
**Goal:** make it visible that Parley is a multi-MM marketplace by running two MMs with distinct configurations and showing competing offers in the Telegram offer card.
 
**Outcomes:**

- [x] Second MM Agent (`mm-2.parley.eth`) registered on Sepolia ENS via the registration script, distinct from `mm-1` (different `MM_SPREAD_BPS` so the two MMs quote distinguishable prices).
- [x] Second container `mm-agent-2` in `compose.yml` running the same image with overrides via a YAML anchor (`x-mm-agent-base`). Distinct `MM_EVM_PRIVATE_KEY`, `MM_ENS_NAME`, `MM_SPREAD_BPS`, bind-mounted `infra/state/mm-agent-2/axl.pem`, and a host port (`127.0.0.1:9012`). Inventory comes from on-chain `balanceOf` (Phase 4 change), so each MM tracks its own funded wallet automatically.
- [x] `KNOWN_MM_ENS_NAMES` extended to include both subnames; existing `axl-mcp.discover_peers` already fans out across all entries in parallel — no code change needed there.
- [x] Telegram offer card rewritten as a multi-button card via `mcp_parley_tg_send_webapp_buttons` (already shipped in Phase 5; Phase 7 only changed the SOUL.md flow that drives it):
  - One Telegram message with stacked rows, one per surviving offer (cap at 3 for screen fit)
  - Each row: MM ENS name, reputation score, output amount, and `peer_advantage_bps` framed as "saves X%" or "⚠ X% worse than Uniswap"
  - Ranked by output amount descending (most output to the user wins); top row marked ⭐ recommended. Reputation is shown for transparency but `min_counterparty_rep` acts as a floor filter, not a weight.
  - User picks one; that offer's `offer_id` flows through the standard accept/lock/settle path. Unpicked offers expire MM-side as no Accept ever lands.

**Supplementary fixes shipped during Phase 7** (small, in scope):

- [x] `phase3:register-mm` parameterized: CLI flags (`--mm <n>`, `--ens`, `--key`, `--axl-pem`, `--axl-pubkey`) with auto-derivation of the AXL ed25519 pubkey from the on-disk PEM (last 32 bytes of SPKI DER, verified to match axl-node's `/topology` `our_public_key`). Replaces the awkward `KNOWN_MM_AXL_PUBKEYS` copy-paste path.
- [x] 0G Storage upload retry on nonce collision. Both `mm-agent` and `mm-agent-2` (and `og-mcp` on the User Agent) sign uploads from a shared `OG_PRIVATE_KEY` — one nonce queue per address. With multi-MM, concurrent publishes hit `REPLACEMENT_UNDERPRICED`. `uploadJsonBlob`/`uploadTradeRecord` now wait+retry (8s/15s/25s backoff) on `REPLACEMENT_UNDERPRICED`/`NONCE_EXPIRED`/equivalent message-substring matches.
- [x] `/balance` was previously dead. SOUL.md instructed the agent to call `eth_getBalance` and `balanceOf` directly, but no MCP tool exposed raw RPC. Added `mcp_parley_og_read_wallet_balance` (one call returns ETH + USDC + WETH, both wei and pre-formatted with the right decimals) and updated SOUL.md to use it.

**Verification:**

- [x] `docker compose config --services` lists 4 services (`user-agent`, `mm-agent`, `mm-agent-2`, `miniapp`); both MMs reach `(healthy)` and emit independent `axl_identity_in_sync` log lines for their respective ENS names.
- [x] Two distinct AXL pubkeys: `mm-agent`'s `our_public_key` differs from `mm-agent-2`'s.
- [x] Both MMs respond to a single intent broadcast within `intent.timeout_ms`; the user sees both offers in one Telegram message distinguished by ENS name.
- [x] Picking one MM proceeds to settlement against that MM only; the other MM's offer expires MM-side without intervention.
- [x] Reputation scores accrue independently per MM via 0G TradeRecords keyed by ENS name; `read_mm_reputation` returns separate histories.

**Demoable state:** the protocol's multi-MM premise is now visible in the demo. The user-facing pitch beat — "two market makers competed for your trade, your agent picked the better one" — is anchored in the actual UI rather than implied by the architecture diagram.
 
---

## Phase 8 — MM Agent live reference pricing

**Estimate:** 0.5–1 day
**Tester readiness:** same as Phase 6 — quotes that actually track the market

**Goal:** replace the Phase-1 hardcoded `3000 USDC/WETH` reference constant with a live Uniswap v3 mid-price refreshed in the background. MM quotes track real Sepolia market state; the intent-handling path stays synchronous (no RPC inline) by reading from an in-memory cache. If the cache is empty or stale, the MM declines to quote rather than emit a mispriced offer.

**Outcomes:**

- [x] New `packages/mm-agent/src/uniswap-reference.ts` module: `setInterval`-driven background loop fetches the Sepolia QuoterV2 mid-price for the configured pair, probes all standard v3 fee tiers, picks the best route, and writes to an in-memory cache with a `fetchedAt` timestamp. Reuses the fee-tier-probe pattern from `packages/user-agent/mcps/og-mcp/src/uniswap.ts`.
- [x] Hardcoded `PHASE1_REFERENCE_TWAP_USDC_PER_WETH_1E18` removed from `packages/mm-agent/src/pricing.ts`. The reference now flows in from the caller via a `referenceTwap1e18: bigint` parameter on `buildOffer`.
- [x] `handleIntent` in `packages/mm-agent/src/index.ts` reads the cached price synchronously — zero added RPC latency on the intent path. If the cached value is older than `MM_PRICE_MAX_STALE_MS` (or the cache is empty), the MM logs `offer_declined`, `reason: "price_unavailable"`. The User Agent's existing "fewer offers than expected → Uniswap fallback" flow handles silence gracefully.
- [x] **Phase 8b: explicit `offer.decline` AXL signal.** New `OfferDecline` message type in `packages/shared/src/types.ts`. The MM emits a decline (unsigned, advisory) before each `return` in both decline paths (`price_unavailable` + `unsupported_pair_or_insufficient_balance`). The User Agent's SOUL.md offer-collection loop counts declines toward the "all MMs responded" stop-condition, short-circuiting the wait when every known MM has either offered or declined. Card body adds a discrete `"N of M MMs declined this intent."` line when N > 0; if all decline, the agent falls through to the existing Uniswap fallback prefixed with *"All MMs declined this intent."* — no per-MM reasons surfaced to the user.
- [x] Two new env vars (with sensible defaults) on the MM Agent:
  - `MM_PRICE_REFRESH_INTERVAL_MS` (default `15000`) — background refresh cadence
  - `MM_PRICE_MAX_STALE_MS` (default `60000`) — hard staleness gate
- [x] Resilience: on RPC failure during a refresh, the cache keeps the prior value (last-good wins until age-out). After 5 consecutive failures, a single `price_refresh_chronic_failure` log is emitted at WARN. The MM self-heals once RPC is back without restart.
- [x] Boot path: `start()` performs the first fetch synchronously so a healthy MM begins accepting intents with a warm cache. If the first fetch fails (RPC unreachable at boot), the MM continues running in decline-to-quote mode until the next successful refresh — no `process.exit(1)`, no operator intervention required.

**Verification:**

- [ ] **Boot waits for first fetch.** `make logs-prod` shows `price_refresh_initial_ok` with a value before the first `intent_received`.
- [ ] **Quotes track real prices.** Send a swap intent. Offer's quoted price is near live Uniswap reference (~2000–2500 USDC/WETH today, not the old 3000 stub). Cross-check against `mcp_parley_og_get_uniswap_reference_quote` on the User Agent side — the two reference prices agree within ~5 bps modulo fetch-time skew.
- [ ] **Intent path is sync.** No new RPC happens during `handleIntent` — log timestamps confirm the lookup is in-memory.
- [ ] **Decline-to-quote on stale cache.** With `MM_PRICE_MAX_STALE_MS=1` (force every read to look stale), the MM logs `offer_declined`, `reason: "price_unavailable"` and sends no offer.
- [ ] **RPC outage at boot self-heals.** With a bogus `SEPOLIA_RPC_URL`, MM boots, logs `price_refresh_initial_failed`, declines all intents. Restore RPC; the next 15s tick succeeds and the MM begins quoting without restart.
- [ ] **Two MMs read the same pool.** Both `mm-agent` and `mm-agent-2` quote prices that differ by exactly `MM_SPREAD_BPS - MM2_SPREAD_BPS` modulo TWAP-fetch skew.
- [ ] **Graceful shutdown.** `make down-prod` cleans up cleanly; no setInterval-related leaks.

**Demoable state:** MM offers reflect live market state. A Sepolia ETH price move shows up in the next quote within 15s. Operator confidence — quotes that mispriced by 20%+ in Phase 7 are now anchored to reality, and a chronic RPC outage produces a clean "no offer from this MM" rather than a mispriced offer.

---

## Phase 9 — Smart routing with partial fills + multi-leg execution

**Estimate:** 1–2 days
**Tester readiness:** the agent visibly *thinks* — picks a fill plan and explains the trade-off

**Goal:** the User Agent stops being a passive offer-displayer and becomes an active router. It computes the optimal fill plan combining 1+ partial peer legs with an optional Uniswap-tail leg, surfaces it as the recommended option (with 1–2 alternatives), and the user picks. Legs execute strict-serial — each leg's chain state confirms `Settled` before the next leg's button appears, preserving per-deal atomicity.

**Outcomes:**

- [x] **MM partial offers.** `negotiator.ts:buildOffer` no longer declines when its inventory can't cover the full intent — it sizes the offer down to whatever's available and emits a partial. The wire-format `Offer` doesn't change; the User Agent detects partial by comparing `offer.deal.amountA < intent.amount`. New helpers `maxOutflow`, `reservedOutflows`, `applyReservations` in `inventory.ts`. New `partial: bool` on `PreparedOffer` for MM-side logging.

- [x] **Concurrent-intent reservation (latent-bug fix).** Before sizing each new offer, the MM subtracts in-flight outflows from prior live offers (`pending: Map<offer_id, PendingDeal>`) from the chain inventory. Two concurrent intents from different users no longer get quoted against the same balance. `reservedOutflows` skips entries past their deadline so the next intent isn't blocked by an effectively-dead reservation.

- [x] **Routing planner tool.** New `mcp_parley_og_compute_routing_plan` in og-mcp. Takes intent + offers + swapper + min_peer_leg_pct (default 25); returns up to 3 ranked plans with full leg breakdowns (`pure_peer | pure_uniswap | multi_leg`), `total_amount_out_wei`, `savings_bps_vs_uniswap`, and a human `summary`. Algorithm: filter offers with deadline < 90s, sort by effective rate descending, greedy-fill until intent covered or peers exhausted, optional Uniswap tail for remainder. Caps tiny legs (< 25% of intent) to avoid gas-eats-savings cases. Reuses existing `prepareFallbackSwap` / `getUniswapQuote` from `uniswap.ts`.

- [x] **SOUL.md plan-based flow** (Steps 6–8 rewritten). Step 6 calls `compute_routing_plan` instead of doing rate math in the LLM. Step 7 surfaces a single message with the recommended plan + 1–2 alternatives as stacked `web_app` buttons. Step 8 is a strict-serial state machine: each leg surfaces only after the previous one's chain state confirms `Settled`/`swapped`. Pre-button deadline re-check replaces stale peer legs with a Uniswap-tail.

- [x] **No contract change.** Each leg is its own atomic `Deal` with its own `lockUserSide` + `lockMMSide` + `settle` cycle. Sequential UI is the intentional cost; an `Aggregator.sol` for single-signature batching is deferred to a future phase.

- [x] **Operator-facing `MM_OFFER_EXPIRY_MS` guidance.** `.env.example` notes the default 5-minute window is fine for 2-leg plans on Sepolia; bump to 600000 (10 min) for 3+ legs or sluggish-RPC environments.

**Verification:**

- [ ] **MM offers partial when inventory short.** Fund MM with only 30 USDC; send a 50 USDC intent. MM emits `offer.quote` with `deal.amountA = 30`, not a decline. `make logs-prod` shows `partial: true` in `offer_sent`.
- [ ] **Concurrent-intent regression test.** Two back-to-back intents from different user wallets requesting 25 USDC each, with MM holding 30 USDC: first gets 25, second gets 5 (or declines if 5 < 25% threshold of the second's intent). MM never over-commits.
- [ ] **Hybrid plan recommended.** With MM-1 offering 30 of 50 USDC at 2% savings, recommended = `[MM-1: 30, Uniswap: 20]`; alternatives = `[All Uniswap]` and `[MM-1 only (30 partial)]`.
- [ ] **Pure Uniswap recommended when all peers worse.** Both MMs offer at rates worse than Uniswap → recommended = `[Uniswap: 50]`. Peer offers don't appear as buttons.
- [ ] **Multi-MM split.** MM-1 offers 25, MM-2 offers 25 → plan `[MM-1: 25, MM-2: 25]`. Leg 2's button surfaces ONLY after leg 1's chain state confirms `Settled`.
- [ ] **Threshold drops tiny legs.** MM-1 offers 5 of 50 (10% < 25%) → MM-1 leg dropped. Recommended = pure Uniswap or MM-2-plus-Uniswap.
- [ ] **Cancel mid-plan.** Tap multi-leg recommendation; after leg 1 settles, type `cancel`. Plan stops; remaining legs unexecuted; user keeps leg 1's output.
- [ ] **Plan-stale deadline rescue.** With `MM_OFFER_EXPIRY_MS=120000`, run a slow leg-1; by the time leg-2 should surface, MM-2's deadline is < 30s. Agent detects, replaces leg-2 + remaining peer legs with a Uniswap-tail, surfaces a `/swap` button, plan completes.
- [ ] **Full plan output verified on-chain.** Recommended `[MM-1: 30, Uniswap: 20]` produces two separate Settlement deals + one Uniswap swap on Sepolia Etherscan. Total received matches the plan's `total_amount_out_wei`.

**Demoable state:** the User Agent stops just listing offers and starts thinking out loud — the chat shows *"recommended plan: 30 USDC via mm-1 + 20 USDC via Uniswap (saves 1.6% vs all-Uniswap)"* with one tap to start. Multi-MM splits visibly demonstrate Parley's value over a single-source aggregator.

---

## Phase 10 — Multi-token support (per-MM token allowlist)

**Estimate:** 1–2 days
**Tester readiness:** more visual variety in the demo — tokens beyond USDC/WETH

**Goal:** lift the Phase-1 hardcoded USDC/WETH constraint. Each MM operator decides which tokens to fund and which pairs to quote on; the User Agent accepts arbitrary user-provided ERC20 addresses (validated on-chain) and routes through MMs that support the requested pair, falling back to Uniswap if none does.

**Outcomes:**

- [x] **Per-MM token registry from env.** New `packages/mm-agent/src/token-registry.ts` parses `MM_TOKEN_ADDRESSES` (`SYMBOL:address:decimals` tuples), `MM_SUPPORTED_PAIRS` (`SYMBOL/SYMBOL` allowlist), `MM_SPREAD_BPS_<SYM_A>_<SYM_B>` (per-pair spread overrides), and `MM_MIN_<SYMBOL>_RESERVE` per token. Backward-compat: when these are unset, falls back to the legacy USDC/WETH-only registry from `SEPOLIA_USDC_ADDRESS` / `SEPOLIA_WETH_ADDRESS`.

- [x] **Generic Inventory.** `packages/mm-agent/src/inventory.ts` was refactored from `Inventory { usdc, weth }` to `Map<Hex, bigint>` keyed by lowercase token address. All helpers (`canFill`, `maxOutflow`, `reservedOutflows`, `applyReservations`, `fetchInventoryFromChain`, `loadReserveLimitsFromEnv`) are now pair-agnostic. Phase 9's reservation accounting still works — outflows are tracked per address in the same shape.

- [x] **Pair-agnostic negotiator.** `pairFromIntent` consults the registry instead of hardcoded USDC/WETH; returns a structured `DeclineReason` (`unsupported_token` / `unsupported_pair` / `insufficient_balance`) on rejection so `handleIntent` can emit a precise `offer.decline` AXL message. `sizeDeal` math drops the `userInIsWeth` boolean — it now works for any (decimalsIn, decimalsOut) combination, including identical-decimals pairs.

- [x] **Direction-aware spread.** Pre-Phase-10 the spread always increased the price; this was correct for USDC→WETH but inverted the direction for WETH→USDC (gave the user MORE USDC than mid). Phase 10 caches reference prices per-direction (`tokenOut per tokenIn × 1e18`) and the spread always REDUCES the price — so the user always gets less tokenOut than mid, regardless of direction. Fixes a latent asymmetry bug.

- [x] **Multi-pair Uniswap reference cache.** `uniswap-reference.ts` now refreshes one cache entry per supported direction (each pair = 2 directions), all in parallel each cycle. Cache is keyed by `(tokenIn, tokenOut)`. Failures per-direction are independent — one stale pair doesn't block the others.

- [x] **`mcp_parley_og_validate_token` tool.** New User Agent MCP tool reads `symbol()` + `decimals()` from a user-provided ERC20 address. Cached per-address. SOUL.md instructs the agent to validate non-canonical token addresses BEFORE building the Intent.

- [x] **Multi-token intent syntax in SOUL.md.** Users can type `swap 10 USDC(0x1c7d...) for UNI(0x1789...)` with explicit address tags. Agent validates each address with the new tool, hand-builds the Intent envelope with the validated `TokenRef`s, signs and broadcasts. MMs that don't support the requested pair decline; if none do, agent falls through to Uniswap fallback with an explanatory note.

**Out of scope (post-Phase-10):**

- **ENS `agent_capabilities` self-heal.** The MM doesn't write its current registry to its ENS subname's `agent_capabilities` text record on every boot. Operators re-run `pnpm phase3:register-mm` if they change `MM_SUPPORTED_PAIRS` and want the User Agent's pre-filter (when added) to know. Functionally OK for now since unsupported pairs decline cleanly via `offer.decline`.
- **Multi-hop Uniswap routing.** When no direct v3 pool exists for the user's pair, the Uniswap fallback fails. Currently no auto-bridging through ETH/USDC. If the User Agent's planner can't find a peer or a direct fallback, the agent tells the user the pair isn't tradable on Sepolia.
- **Pre-broadcast pair filter.** User Agent broadcasts to all known MMs; relies on `offer.decline` to handle non-supporting MMs. A pre-filter via ENS `agent_capabilities` reads is possible but adds discovery latency for marginal benefit.
- **Mini App symbol display.** The Mini App still doesn't read `symbol()` at render time; it shows the address+symbol from the deal struct as-is. Adding chain reads to the client is a polish item.
- **Adaptive spread per-pair-depth.** `MM_SPREAD_BPS_<SYM>_<SYM>` is operator-configured static. A real MM would adjust spreads to pool depth and volatility. Listed under SPEC §11.4 long-term.

**Verification:**

- [ ] **Single-pair fallback works.** With `MM_TOKEN_ADDRESSES` and `MM_SUPPORTED_PAIRS` unset, the MM boots with the legacy USDC/WETH registry derived from `SEPOLIA_*_ADDRESS`. Existing USDC/WETH demo flows continue to work.
- [ ] **Multi-token registry parses correctly.** With `MM_TOKEN_ADDRESSES=USDC:0x1c7d...:6,WETH:0xfff9...:18,UNI:0x1789...:18` and `MM_SUPPORTED_PAIRS=USDC/WETH,USDC/UNI`, the boot log shows `supported_pairs: ["USDC/WETH","USDC/UNI"]` and per-token balances/reserves.
- [ ] **Unsupported pair declines cleanly.** Send a `WETH/UNI` intent (token in registry but pair not in allowlist). MM logs `offer_declined`, `reason: "unsupported_pair"` and emits the AXL decline.
- [ ] **Unsupported token declines cleanly.** Send an intent with a random ERC20 address not in `MM_TOKEN_ADDRESSES`. MM logs `offer_declined`, `reason: "unsupported_token"`.
- [ ] **Direction-aware spread works for both directions.** With `MM_SPREAD_BPS_USDC_WETH=10`, a USDC→WETH intent and a WETH→USDC intent both produce offers ~10 bps WORSE than the cached mid (user gets less tokenOut in both cases).
- [ ] **`validate_token` rejects garbage addresses.** Calling the tool with a random non-contract address returns `{ ok: false, error }` and the agent doesn't broadcast.
- [ ] **Cross-package typecheck + build clean.**

**Demoable state:** the agent can swap USDC↔WETH, USDC↔UNI, WETH↔UNI on Sepolia (or any operator-configured pairs). MM operators decide per-deployment which tokens they fund and quote — Parley's marketplace is no longer a fixed two-token demo.

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