# Parley — Deployment Notes

**Status:** working document. Captures everything we know about deploying Parley. Phase 6a translated the open items into committed artifacts: three `Dockerfile`s under `infra/`, a `compose.yml` at the repo root, and a `Makefile` with `make deploy-local` as the single bring-up command. This doc remains the rationale layer behind those artifacts.

**Target:** Sepolia + Galileo testnet only. Mainnet is out of scope for v1.0 (spec §11).

---

## 1. Services and process topology

There are **eight logical processes**, hosted across three machines (or three Docker contexts):

| Host | Process | Language | Purpose |
|---|---|---|---|
| User Agent host | Hermes Agent | **Python** (LLM-driven) | Telegram gateway, MCP host, per-user state. System-installed (`curl \| bash`); state in `~/.hermes/`. |
| | `axl-mcp` | TS (MCP server) | Hermes ↔ AXL bridge; privileged tool validation |
| | `og-mcp` | TS (MCP server) | Hermes ↔ 0G Storage + ENS |
| | `axl-sidecar` | TS | Polls `GET /recv`, injects msgs into Hermes; chain-watcher |
| | `axl-node-user` | Go binary | This agent's identity on the AXL mesh |
| MM Agent host | `mm-agent` daemon | TS | Pricing, offer signing, `lockMMSide` submission |
| | `axl-node-mm` | Go binary | This MM's identity on the AXL mesh |
| Mini App host | `miniapp` | Next.js (Node) | Wallet signing surface, behind HTTPS reverse proxy |

**Container packaging — committed in Phase 6a: one container per host (3 services).**

The `compose.yml` at the repo root runs three services: `user-agent`, `mm-agent`, `miniapp`. Each agent image bundles its own AXL Go binary as a sibling process, supervised by `supervisord` (User Agent) or a small bash entrypoint with `tini` as PID 1 (MM Agent). The Mini App is a single Node process. Mixed Go/Node/Python in a single container is the explicit trade-off — simpler compose plumbing in exchange for shared crash blast-radius. We may split per-process if any one becomes a noisy neighbor, but that's a Phase 7+ concern.

---

## 2. Per-service env / secret / port matrix

Every variable in `.env.example` mapped to consumers. Empty cell = not needed.

| Variable | user-agent | mm-agent | miniapp | Notes |
|---|:---:|:---:|:---:|---|
| `SEPOLIA_RPC_URL` | ✓ | ✓ | ✓ | **Paid provider only** (Alchemy/Infura/QuickNode). Public RPCs flake under load — flagged in roadmap risk register; specifically `eth_newFilter` handles get dropped between polls (see `sepolia_rpc_filter_quirk` memory). |
| `SETTLEMENT_CONTRACT_ADDRESS` | ✓ | ✓ |  | Set after one-time Phase 1 deploy. Currently `0xE5e766d8fEdd8705d537D0016f1A2bff852fE219`. |
| `USER_AXL_HTTP_URL` | ✓ |  |  | User Agent's local AXL HTTP API. Default `http://localhost:9002`. |
| `AXL_HTTP_URL` |  | ✓ |  | MM Agent's local AXL HTTP API. Default `http://localhost:9012`. Each agent has its own AXL node — same vars name was reused historically; pin per-process via env. |
| `AXL_PRIVATE_KEY_PATH` | ✓ | ✓ |  | **File path, not env value.** See §3. |
| `KNOWN_MM_ENS_NAMES` | ✓ |  |  | Comma-separated MM ENS names the User Agent fans out to (resolved via on-chain ENS in Phase 3). |
| ~~`KNOWN_MM_AXL_PUBKEYS`~~ | — | — | — | **Phase 3: deprecated.** AXL pubkeys are derived from ENS `axl_pubkey` text records now. Still in `.env.example` for reference; safe to remove. |
| `PARLEY_ROOT_PRIVATE_KEY` | — | — | — | **One-time scripts only** (`register-mm.ts` for ENS subnames). Never in any runtime container. Currently owns `parley.eth` AND `mm-1.parley.eth` on Sepolia (Phase 4 transfers subname ownership to MM_EVM — see §6). |
| `TELEGRAM_BOT_TOKEN` | ✓ |  |  | Hermes' Telegram gateway uses this; same bot must be allowlisted via @BotFather pairing flow (see §8 Hermes pairing note). |
| `ANTHROPIC_API_KEY` | ✓ |  |  | **Phase 2 primary LLM.** Hermes points at Claude API directly. Required. |
| `ZG_COMPUTE_ENDPOINT` | (✓) |  |  | **Phase 2 decision: deferred.** Used only after the 0G Compute proxy ships in Phase 4 (per `zg_compute_findings` memory: per-request signed headers, no static API key). Optional until then. |
| `ZG_COMPUTE_KEY` | (✓) |  |  | Same — unused by Hermes directly. |
| `ZG_COMPUTE_PROVIDER` | (✓) |  |  | Same. |
| `ZG_STORAGE_RPC_URL` | ✓ | ✓ |  | Reads (User Agent reputation lookups) + writes (both: trade records). Phase 4. |
| `ZG_STORAGE_INDEXER_URL` | ✓ | ✓ |  | Same. |
| `OG_PRIVATE_KEY` | ✓ | ✓ |  | Pays storage uploads (and Compute, for the User Agent). Each agent should have **its own** key in production — don't share one wallet across the User Agent and MM Agent. |
| `MM_EVM_PRIVATE_KEY` |  | ✓ |  | Sepolia hot wallet. Funded with Sepolia ETH for gas + tokenB inventory. The `addr` text record on `mm-1.parley.eth` resolves to this wallet's address. |
| `MM_ENS_NAME` |  | ✓ |  | e.g. `mm-1.parley.eth`. Matches what the User Agent has in `KNOWN_MM_ENS_NAMES`. |
| `MM_SPREAD_BPS` |  | ✓ |  |  |
| `MM_MIN_USDC_RESERVE`, `MM_MIN_WETH_RESERVE` |  | ✓ |  | Optional reserves the MM holds aside when sizing offers (human units; default 0). Available inventory itself is read live from chain `balanceOf` per-intent — fund the MM hot wallet externally and quoting follows the chain immediately, no restart needed. The retired `MM_INVENTORY_USDC` / `MM_INVENTORY_WETH` env vars (env-driven caps) are gone. |
| `MM_OFFER_EXPIRY_MS`, `MM_SETTLEMENT_WINDOW_MS` |  | ✓ |  | Default 120000 / 300000. |
| `SEPOLIA_USDC_ADDRESS`, `SEPOLIA_WETH_ADDRESS` | ✓ | ✓ |  | TestERC20 addresses (Phase 1 deployments). Swap to canonical Sepolia USDC/WETH if running with non-test users. |
| `MINIAPP_BASE_URL` | ✓ |  |  | HTTPS URL the bot embeds in `web_app` buttons. Stable hostname required (Telegram refuses non-HTTPS; cached after the first BotFather config). |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |  |  | ✓ | **Baked at `next build`.** See §4. |
| `NEXT_PUBLIC_SETTLEMENT_CONTRACT_ADDRESS` |  |  | ✓ | Same. |
| `NEXT_PUBLIC_CHAIN_ID` |  |  | ✓ | `11155111`. Baked. |
| `MINIAPP_JWT_SIGNING_KEY` |  |  | ✓ | Server-only (signs JWTs the bot will embed in Mini App URLs in Phase 4 — currently unused, URLs are unsigned). |
| `UNISWAP_API_URL`, `UNISWAP_API_KEY` | ✓ |  |  | User Agent only — fallback path + reference price. Phase 5. |

**Single `.env` strategy.** We're keeping one root-level `.env` as the source of truth (already wired into `next.config.mjs` via `process.loadEnvFile`). Build/deploy pipeline must:

- Mount it (read-only) into each runtime container as `/run/secrets/parley.env` or similar, **never `COPY .env`** into the image.
- Read it during `next build` so `NEXT_PUBLIC_*` get baked into the client bundle.
- Strip secrets the service doesn't need (defense in depth — User Agent doesn't need `MM_EVM_PRIVATE_KEY`).

---

## 3. Persistent state and file-shaped secrets

Things that **must survive container restarts** and therefore need named volumes (or external secret stores):

| Path | Owner | What | Why durable |
|---|---|---|---|
| `axl.pem` (User Agent) | user-agent host | ed25519 PEM | Identity on AXL mesh. New PEM = new pubkey = User Agent looks like a stranger to MMs. |
| `axl.pem` (MM Agent) | mm-agent host | ed25519 PEM | Same; **also published as `text("axl_pubkey")` ENS record on `mm-N.parley.eth`.** Re-keying = stale ENS, MMs unreachable until re-registered. |
| `~/.hermes/` | user-agent host | Hermes' state dir | Holds DM pairing data (`pairing/`), session memory, MCP config, model config, conversation history. Mount as a named volume; losing it forces every Telegram user to re-pair (per `hermes_pairing_flow` memory) and drops all in-flight session bindings. |
| `~/.hermes/SOUL.md` + `~/.hermes/skills/` | user-agent host | Procedural memory | Synced from `packages/user-agent/hermes-config/` at deploy time (see §4). The repo is the source of truth — symlink or copy at install. |
| Foundry deploy artifacts | dev machine | tx hash, contract address | Not container state — committed/recorded at deploy. Source for `SETTLEMENT_CONTRACT_ADDRESS`. |

**Things that look like state but aren't:**

- 0G Storage uploads — on-chain, no local cache.
- 0G Compute ledger — on-chain.
- Reputation records — derived on read from 0G Storage; no local mirror.

---

## 4. Build pipeline — what gets built when

```
Step 1 (one-time):
  - forge build && forge script Deploy.s.sol  → SETTLEMENT_CONTRACT_ADDRESS into .env
  - forge script DeployTestTokens.s.sol       → SEPOLIA_USDC/WETH_ADDRESS into .env
                                                (skip if using canonical Sepolia tokens)
  - pnpm -F @parley/user-agent phase3:register-mm
                                              → mm-N.parley.eth on Sepolia ENS with
                                                addr / axl_pubkey / agent_capabilities
                                                text records

Step 2 (per release):
  - pnpm install --frozen-lockfile
  - pnpm -F @parley/shared        build        # types other packages depend on
  - pnpm -F @parley/og-mcp        build        # tsc → dist/
  - pnpm -F @parley/axl-mcp       build        # tsc → dist/
  - pnpm -F @parley/user-agent    build        # tsc → dist/ (sidecar)
  - pnpm -F @parley/mm-agent      build        # tsc → dist/
  - pnpm -F @parley/miniapp       sync-assets  # mirrors artifacts/ into miniapp/public/
  - pnpm -F @parley/miniapp       build        # next build — reads NEXT_PUBLIC_* from .env
  - cd ~/GitHub/axl && make build              # produces ./node binary; copy into images

Step 3 (image build):
  - User Agent image: Python 3.11+ base (for Hermes) + Node 24 (for MCPs) + Go binary
                      + og-mcp dist/ + axl-mcp dist/ + axl-sidecar dist/
                      + hermes-config/ (SOUL.md + skills/) mounted into ~/.hermes/
  - MM Agent image:   Node 24 base + Go binary + mm-agent dist/
  - Mini App image:   Node 24 base + .next/ + public/ (logo + favicons + OG cards
                      from sync-assets)
```

**`sync-assets` step is required before `next build`.** The Mini App's `public/favicon/`, `public/social/`, and root-level `lockup-horizontal.svg` / `mark.svg` are mirrored from `/artifacts/` (which is the source of truth — see CLAUDE.md "Logos and assets"). If you regenerate `artifacts/build.py` outputs and skip `sync-assets`, the deployed Mini App ships stale logos and the manifest's icon paths can 404.

**Hermes config sync at install time.** The repo holds canonical SOUL.md + skills under `packages/user-agent/hermes-config/`. Hermes reads its system prompt and skills from `~/.hermes/`. Pick one of:
- **Symlink** at install: `ln -sf $(pwd)/packages/user-agent/hermes-config/SOUL.md ~/.hermes/SOUL.md` and same for `skills/`.
- **Copy + watch** if symlinks are awkward in the deployment env (Docker volumes that can't symlink across mount boundaries, etc.).

In dev, the symlink keeps Hermes in sync with edits without restart.

**Hermes packaging — committed in Phase 6a: bake-install at a pinned version.** `infra/Dockerfile.user-agent` runs `curl https://hermes-agent.nousresearch.com/install.sh | bash` with `HERMES_VERSION=0.11.0` pinned via build arg. Bumping is a deliberate Dockerfile edit. The supervisord program calls `hermes gateway run` (NOT `start` — Hermes refuses to fork under PID 1).

**`NEXT_PUBLIC_*` gotcha:** these are inlined into the client JS bundle by webpack at build time. They cannot be changed after `next build` without rebuilding. Concretely:

- Changing the deployed Settlement contract = rebuild the Mini App.
- Rotating the WalletConnect project ID = rebuild the Mini App.
- These should be considered **part of the artifact**, not part of the runtime config.

Server-only env (`MINIAPP_JWT_SIGNING_KEY`, anything not prefixed `NEXT_PUBLIC_`) can change at runtime without rebuilds.

---

## 5. Networking

| Service | Inbound | Outbound | Visibility |
|---|---|---|---|
| `axl-node-user` | TCP `9001/tls` if listening (only public peers need this — User Agent is fine NAT'd) | TCP outbound to AXL peers | localhost-only HTTP API on `9002` |
| `axl-node-mm` | same | same | same |
| `user-agent` (Hermes etc.) | none | Telegram, 0G, AXL local, Sepolia RPC | localhost only |
| `mm-agent` | none | Sepolia RPC, AXL local, 0G | localhost only |
| `miniapp` | `443` (HTTPS, behind reverse proxy) | Sepolia RPC (read-only chain queries) | public |

**Reverse proxy** in front of the Mini App (Caddy is simplest — auto-LE TLS). The Mini App's hostname must be:

- **Stable** (Telegram caches the `web_app` URL set in BotFather; rotating it requires bot reconfiguration).
- **HTTPS** (Telegram refuses non-HTTPS Mini App URLs).
- **Allowlisted in the WalletConnect Cloud dashboard** (WC's project domain allowlist; mismatched = "Origin not allowed" error in production).

---

## 6. External configurations that must align

Things outside the repo that need to match production deployment values. Easy to forget; expensive when wrong.

- **WalletConnect Cloud (cloud.reown.com):** add the Mini App's production hostname to the project's allowed domains. Required for the WC modal to load wallets in production.
- **Telegram BotFather:** `/setdomain` (Login Widget) and the `web_app` URL on the bot's menu button must point to the production Mini App URL. The bot token in the env must match the same bot. **Bot avatar:** upload `artifacts/png/avatar-dark-512.png`.
- **ENS subnames (Sepolia):** `mm-N.parley.eth` is registered via `pnpm phase3:register-mm`. Sets `addr` → `MM_EVM`, `axl_pubkey` → the AXL ed25519 pubkey, `agent_capabilities` → JSON. Subname ownership transfers to `MM_EVM` so the MM Agent can update its own `reputation_root` (Phase 4) and `axl_pubkey` (self-heal on rotation, see below) without `PARLEY_ROOT` involvement at runtime.
- **AXL pubkey ↔ ENS auto-sync:** the MM Agent verifies on every boot that the `axl_pubkey` ENS text record matches its locally mounted `axl.pem`. On mismatch (key rotation, fresh container, new operator) it self-heals by signing a single `Resolver.setText` from `MM_EVM`. Controlled by `MM_AUTO_REGISTER_AXL` (default `true`). Set to `false` in production where every chain write should be reviewed — boot will then refuse to start on drift, with an actionable error message pointing at `pnpm phase3:register-mm`. Without this sync, `broadcast_intent` from the User Agent dials a stale Yggdrasil overlay IPv6 derived from the old pubkey and hangs in a 127s gVisor TCP SYN timeout — the Phase 6a footgun this fix closes.
- **GitHub repo settings:** social preview image → `artifacts/png/app-icon-light-256.png` (or `-dark-256.png`).
- **Sepolia funding (Phase 5+ — real tokens):** the demo now uses real Sepolia USDC (`0x1c7D…7238`) and WETH (`0xfFf9…6B14`); the legacy TestERC20-based `mUSDC`/`mWETH` are archived. Both the MM hot wallet (`MM_EVM`) and the user persona need:
  - Sepolia ETH for gas — any standard Sepolia faucet (e.g. `sepoliafaucet.com`, `cloud.google.com/application/web3/faucet/ethereum/sepolia`).
  - Sepolia USDC — claim from Circle's faucet at `https://faucet.circle.com` (select Sepolia).
  - Sepolia WETH — wrap a small amount of Sepolia ETH into WETH9 by sending ETH to `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` (the contract's `receive()` mints WETH 1:1) or via the Uniswap web app.
  - The MM Agent boot now refuses to start if its hot wallet is under-inventoried for either token and prints a faucet hint. The user persona's allowance to `Settlement` is detected and prompted for in the Mini App's `/sign` route (Phase 4 polish — already wired).
- **Uniswap fallback (on-chain v3, not Trading API):** `og-mcp.prepare_fallback_swap` and `get_uniswap_reference_quote` read directly from QuoterV2 (`0xEd1f…2FB3`) and encode calldata for SwapRouter02 (`0x3bFA…48E`) on Sepolia. No API key required — both tools route through `SEPOLIA_RPC_URL`. Empirically, the Uniswap Trading API gateway does not index Sepolia (returns "No quotes available" even for known-routable pairs); on-chain QuoterV2 calls work. If you later want Trading-API mainnet routing, the architecture supports a chain-aware switch but the demo doesn't need it.
- **0G ledger:** funded with at least 1 OG locked balance per acknowledged provider, plus headroom (we hit the floor in Phase 0 testing — see `zg_compute_findings`). Phase 4 only.

---

## 7. Order-of-start

In `compose.yml` parlance, the dependency chain:

```
axl-node-user           axl-node-mm
        ↓                       ↓
   user-agent              mm-agent
   (Hermes,            (waits for both
    axl-mcp,            AXL local API
    og-mcp,             and Sepolia RPC
    axl-sidecar)        before serving)
                              ↓
                     (Settlement contract
                      address must already
                      be deployed; deploy is
                      out-of-band, not in compose)

miniapp  ←  needs nothing from agents at startup; only the deployed contract
            address (baked at build time) and a reachable Sepolia RPC for
            chain reads.
```

Add explicit `depends_on` + healthchecks — agents should fail fast if their AXL node isn't reachable (curl `/topology`).

---

## 8. Operational concerns

- **NTP / clock sync.** EIP-712 deadlines and intent expiries depend on accurate time. Host clock + container time must be honest. Default Linux NTP is fine; just don't disable it.
- **Process supervision.** Anything inside an "all-in-one" container needs a supervisor that restarts individual processes (don't rely on Docker restart policies to handle a single child crash).
- **Logging.** Spec mandates structured (JSON) logs across User Agent, MM Agent, Mini App in Phase 4. Pick a destination early (stdout is fine, aggregator TBD).
- **Backups.** The two `axl.pem` files and the deployer wallet PKs are the only true non-recreatable state. Cold backup somewhere outside the host.
- **Rotation.** Plan for rotating `MM_EVM_PRIVATE_KEY` (drain, redeploy with new key, update ENS `addr` record, restart). Plan for rotating `axl.pem` (new key, re-register `axl_pubkey` text record, restart).
- **Telegram rate limits.** Mitigation per spec: edit messages instead of sending new ones for live status updates. If 429s appear, basic backoff.
- **Sepolia chain-watcher RPC choice.** The AXL sidecar uses `getContractEvents` polling rather than `viem.watchContractEvent` because public Sepolia RPCs (publicnode.com tested) drop `eth_newFilter` handles between polls (`sepolia_rpc_filter_quirk` memory). Once on a paid RPC that persists filters, the sidecar should switch back to `watchContractEvent` for lower latency.
- **Logo asset sync.** When updating logos, edit `artifacts/svg/`, regenerate via `artifacts/build.py`, then run `pnpm -F @parley/miniapp sync-assets` and rebuild. Skipping `sync-assets` ships stale icons (CLAUDE.md "Logos and assets" has the full convention).
- **Hermes DM pairing for production.** During Phase 2 dev we set `unauthorized_dm_behavior: ignore` to silence pairing prompts on a single-user dev box. **Production deploy must reverse this** — either re-enable pairing (default) and approve users via `hermes pairing approve telegram <CODE>`, or curate `TELEGRAM_ALLOWED_USERS` in `~/.hermes/.env` with the explicit Telegram user IDs allowed to talk to the bot. Without one of those, anyone who finds the bot's username gets nothing (silent black hole) — fine for staging, but degrades the demo onboarding experience. See `hermes_pairing_flow` memory for the full flow.
- **Multi-user isolation verification.** Phase 2 baseline (ROADMAP §1 outcome 1) requires confirming Hermes' per-Telegram-user state isolation works under load — two test accounts, simultaneous sessions, no context leakage. Deferred during dev; **must be checked before declaring Phase 2 closed for any external tester**.

---

## 9. What this doc still doesn't answer

Open questions to resolve as Phase 2-5 lands. Each becomes a section here when answered.

- **MM subname ownership transfer (Phase 4).** Currently `parley.eth` and all its subnames are owned by `PARLEY_ROOT`. The MM needs to update its own `text("reputation_root")` after each settled trade — that requires either (a) `setSubnodeOwner(parentNode, label, MM_EVM)` to transfer ownership, or (b) resolver-level `approve(node, MM_EVM, true)` so the MM can call `setText` without owning the subname. Decide before Phase 4's reputation-write path lands.
- **Hermes config split (config vs secrets).** `~/.hermes/config.{yaml,toml}` is generated by `hermes setup` and contains a mix of model selection (reproducible) and API keys (secret). For container deploys, decide whether to (a) check config into the repo and mount over secrets, (b) re-run `hermes setup --non-interactive` per-environment, or (c) generate config from a template at boot. Production-grade ops question; staging can keep the dev config.
- **Single-machine vs split deployment.** Demo cost of running everything on one VPS vs. cleanly separating User Agent and MM Agent infra. (One-VPS is fine for the demo.)
- **Mini App secret handling for `MINIAPP_JWT_SIGNING_KEY`.** Random per-deploy or stable? Stable means JWTs survive deploys — preferable for in-flight sessions. (Currently unused; Phase 4 polish.)
- **AXL node listen vs NAT.** Demo can run all nodes NAT'd behind the existing public Gensyn nodes. Production should run at least one Parley-operated public AXL peer for resilience.
- **CI/CD pipeline.** Push-to-deploy? Manual? Out of scope here until we know the host.
