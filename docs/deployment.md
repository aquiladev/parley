# Parley — Deployment Notes

**Status:** working document. Captures everything we know now about deploying Parley to a server. Updated as Phase 1+ surfaces real runtime details. Translated into concrete `Dockerfile` / `compose.yml` artifacts in Phase 5 — until then this is the source-of-truth checklist.

**Target:** Sepolia + Galileo testnet only. Mainnet is out of scope for v1.0 (spec §11).

---

## 1. Services and process topology

There are **eight logical processes**, hosted across three machines (or three Docker contexts):

| Host | Process | Language | Purpose |
|---|---|---|---|
| User Agent host | Hermes Agent | TS (LLM-driven) | Telegram gateway, MCP host, per-user state |
| | `axl-mcp` | TS (MCP server) | Hermes ↔ AXL bridge; privileged tool validation |
| | `og-mcp` | TS (MCP server) | Hermes ↔ 0G Storage + ENS |
| | `axl-sidecar` | TS | Polls `GET /recv`, injects msgs into Hermes; chain-watcher |
| | `axl-node-user` | Go binary | This agent's identity on the AXL mesh |
| MM Agent host | `mm-agent` daemon | TS | Pricing, offer signing, `lockMMSide` submission |
| | `axl-node-mm` | Go binary | This MM's identity on the AXL mesh |
| Mini App host | `miniapp` | Next.js (Node) | Wallet signing surface, behind HTTPS reverse proxy |

**Container packaging — undecided, document the options:**

- **Tightly bundled:** one container per host, with `supervisord` / `pm2` running all processes inside. Simpler ops, but mixed runtimes (Go + Node) and harder to recycle one process without affecting others.
- **One container per process:** cleaner restarts and resource limits, more compose plumbing. Each AXL node is its own container.

Recommendation: start with **one container per host** (3 containers total in compose), revisit if any process needs independent scaling.

---

## 2. Per-service env / secret / port matrix

Every variable in `.env.example` mapped to consumers. Empty cell = not needed.

| Variable | user-agent | mm-agent | miniapp | Notes |
|---|:---:|:---:|:---:|---|
| `SEPOLIA_RPC_URL` | ✓ | ✓ | ✓ | **Paid provider only** (Alchemy/Infura/QuickNode). Public RPCs flake under load — flagged in roadmap risk register. |
| `SETTLEMENT_CONTRACT_ADDRESS` | ✓ | ✓ |  | Set after one-time Phase 1 deploy. |
| `AXL_HTTP_URL` | ✓ | ✓ |  | `http://localhost:9002` from inside the agent's container; pin via container DNS if separated. |
| `AXL_PRIVATE_KEY_PATH` | ✓ | ✓ |  | **File path, not env value.** See §3. |
| `KNOWN_MM_ENS_NAMES` | ✓ |  |  | Comma-separated MM ENS names the User Agent fans out to. |
| `PARLEY_ROOT_PRIVATE_KEY` | — | — | — | **One-time scripts only** (`register-mm.ts`). Never in any runtime container. |
| `TELEGRAM_BOT_TOKEN` | ✓ |  |  |  |
| `ZG_COMPUTE_ENDPOINT` | (✓) |  |  | Pending Phase 2 decision: direct broker SDK vs Claude API fallback. See `zg_compute_findings` memory. |
| `ZG_COMPUTE_KEY` | (✓) |  |  | Same. |
| `ZG_COMPUTE_PROVIDER` | (✓) |  |  | Provider address acknowledged via 0g-compute-cli. |
| `ANTHROPIC_API_KEY` | ✓ |  |  | Spec-documented LLM fallback; may become primary. |
| `ZG_STORAGE_RPC_URL` | ✓ | ✓ |  | Reads (User Agent reputation lookups) + writes (both: trade records). |
| `ZG_STORAGE_INDEXER_URL` | ✓ | ✓ |  |  |
| `OG_PRIVATE_KEY` | ✓ | ✓ |  | Pays storage uploads (and Compute, for the User Agent). Each agent should have **its own** key in production — don't share one wallet across the User Agent and MM Agent. |
| `MM_EVM_PRIVATE_KEY` |  | ✓ |  | Sepolia hot wallet. Funded with Sepolia ETH for gas + tokenB inventory. |
| `MM_ENS_NAME` |  | ✓ |  | e.g. `mm-1.parley.eth`. Matches what the User Agent has in `KNOWN_MM_ENS_NAMES`. |
| `MM_SPREAD_BPS` |  | ✓ |  |  |
| `MM_INVENTORY_USDC`, `MM_INVENTORY_WETH` |  | ✓ |  |  |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` |  |  | ✓ | **Baked at `next build`.** See §4. |
| `NEXT_PUBLIC_SETTLEMENT_CONTRACT_ADDRESS` |  |  | ✓ | Same. |
| `NEXT_PUBLIC_CHAIN_ID` |  |  | ✓ | `11155111`. Baked. |
| `MINIAPP_JWT_SIGNING_KEY` |  |  | ✓ | Server-only (signs JWTs the bot embeds in Mini App URLs). |
| `UNISWAP_API_URL`, `UNISWAP_API_KEY` | ✓ |  |  | User Agent only — fallback path + reference price. |

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
| Hermes session memory | user-agent host | TBD (Phase 2) | Per-Telegram-user state (`session_sig`, wallet binding, in-flight intents). Spec says in-process; need to confirm Hermes' persistence story before assuming we can recycle the container without losing live sessions. |
| Foundry deploy artifacts | dev machine | tx hash, contract address | Not container state — committed/recorded at deploy. Source for `SETTLEMENT_CONTRACT_ADDRESS`. |

**Things that look like state but aren't:**

- 0G Storage uploads — on-chain, no local cache.
- 0G Compute ledger — on-chain.
- Reputation records — derived on read from 0G Storage; no local mirror.

---

## 4. Build pipeline — what gets built when

```
Step 1 (one-time):
  - forge build && forge script Deploy.s.sol → SETTLEMENT_CONTRACT_ADDRESS recorded into .env
  - register-mm.ts → MM ENS subnames published with text records

Step 2 (per release):
  - pnpm install --frozen-lockfile
  - pnpm -F @parley/shared build          # types other packages depend on
  - pnpm -F @parley/user-agent build      # tsc → dist/
  - pnpm -F @parley/mm-agent build        # tsc → dist/
  - pnpm -F @parley/miniapp build         # next build — reads NEXT_PUBLIC_* from .env
  - cd ~/GitHub/axl && make build         # produces ./node binary; copy into images

Step 3 (image build):
  - User Agent image: Node 24 base + Go binary copied in + dist/ + hermes-config/
  - MM Agent image: Node 24 base + Go binary + dist/
  - Mini App image: Node 24 base + .next/ + public/
```

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
- **Telegram BotFather:** `/setdomain` (Login Widget) and the `web_app` URL on the bot's menu button must point to the production Mini App URL. The bot token in the env must match the same bot.
- **ENS subnames (Sepolia):** `mm-N.parley.eth` text records (`addr`, `axl_pubkey`, `agent_capabilities`, `reputation_root`) must match the **production** AXL pubkey and EVM addr. Re-running registration after a key rotation is mandatory.
- **Sepolia funding:** MM Agent's hot wallet must hold both Sepolia ETH (gas) and inventory tokens (`tokenB`). User personas trading need Sepolia USDC / WETH approvals to the Settlement contract.
- **0G ledger:** funded with at least 1 OG locked balance per acknowledged provider, plus headroom (we hit the floor in Phase 0 testing — see `zg_compute_findings`).

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

---

## 9. What this doc still doesn't answer

Open questions to resolve as Phase 2-5 lands. Each becomes a section here when answered.

- **Hermes persistence model.** Does session memory survive process restarts? If not, what does graceful container reload look like?
- **Single-machine vs split deployment.** Demo cost of running everything on one VPS vs. cleanly separating User Agent and MM Agent infra. (One-VPS is fine for the demo.)
- **Mini App secret handling for `MINIAPP_JWT_SIGNING_KEY`.** Random per-deploy or stable? Stable means JWTs survive deploys — preferable for in-flight sessions.
- **AXL node listen vs NAT.** Demo can run all nodes NAT'd behind the existing public Gensyn nodes. Production should run at least one Parley-operated public AXL peer for resilience.
- **CI/CD pipeline.** Push-to-deploy? Manual? Out of scope here until we know the host.
