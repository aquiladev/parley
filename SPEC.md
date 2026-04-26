# Parley — Technical Specification

**Specification version:** 1.2
**Tagline:** *the agent layer for peer DeFi*
**Target chain:** Sepolia testnet

Parley is a peer-to-peer DeFi negotiation protocol. AI agents representing users and market makers discover each other, negotiate trades over an encrypted P2P network, and settle atomically on-chain. When no peer match is found, the User Agent automatically falls back to AMM liquidity. Reputation is portable, identity is asymmetric (public for market makers, pseudonymous for users), and every settlement transaction is verifiable.

**Trust model:** the User Agent operates *on behalf of* the user but holds no spendable funds. All User-side transactions (lock, settle, fallback swap) are submitted from the user's own wallet via the Telegram Mini App. The agent prepares calldata; the user signs and submits. The MM Agent runs its own funded hot wallet because it is operated by a known, motivated party with a business reason to keep it provisioned.

**Identity asymmetry:** market makers register an ENS subname under `parley.eth` so they can be discovered, evaluated, and addressed by other agents. Users do not. A user's identity is their wallet address; reputation is keyed by wallet. Users who specifically want a human-readable handle and cross-wallet reputation portability may opt into an ENS subname (Section 4.5.3), but it is not required to use Parley.

**Chain scope:** Parley currently runs on **Sepolia testnet only**. Users need a Sepolia-funded wallet to trade. There is no mainnet deployment yet; mainnet migration is on the roadmap.

---

## 1. Overview

Parley is a peer-to-peer DeFi negotiation protocol where AI agents discover counterparties, negotiate trades over an encrypted network, and settle atomically on-chain. When no peer match is found, the User Agent automatically falls back to on-chain liquidity (Uniswap).

**Two agent types:**

- **User Agent** — represents one user's policy and capital. Broadcasts intents, evaluates offers, falls back to AMM if no peer match.
- **Market Maker Agent** — listens for intents, generates quotes, settles with User Agents.

**Integrations:**

- **[Gensyn AXL](https://docs.gensyn.ai/tech/agent-exchange-layer)** — agent-to-agent encrypted messaging over a peer-to-peer mesh
- **[0G Storage](https://build.0g.ai/storage/) + [0G Compute](https://build.0g.ai/compute/)** — decentralized reputation history and LLM inference with TEE attestation
- **[Uniswap Trading API](https://developers.uniswap.org/docs/trading/swapping-api/getting-started)** — fallback liquidity routing and real-time reference pricing
- **[ENS](https://docs.ens.domains/)** — canonical identity layer for **MM Agents**; subname schema with text records carrying AXL pubkey, capabilities, and reputation pointer. User Agents may opt into ENS subnames for portability but do not require them.

See Section 12 for full documentation references.

**Trying Parley.**

v1.0 runs on Sepolia testnet. To trade, you need:

1. A Telegram account
2. A wallet with WalletConnect support (MetaMask Mobile recommended)
3. A small amount of Sepolia ETH for gas (~0.01 Sepolia ETH covers several trades). Get some from a public Sepolia faucet — for example, `https://sepoliafaucet.com` or any other faucet your wallet supports.
4. Test tokens (USDC + WETH on Sepolia) to actually trade — the trading-pair faucet links are surfaced by the bot when needed.

The first time you message the Parley bot, it walks you through a single step: connect your wallet and sign a session-binding message (Section 4.5.1). That's it — you can immediately start trading. The session binding lasts 24 hours; after that, you re-sign once and continue.

There is no on-chain registration required. Your identity is your wallet address. Reputation accrues against your wallet. If you'd like a human-readable handle (`alice.parley.eth`) and the ability to carry reputation across wallet rotations, you can optionally register one at any time via `/register <handle>` (Section 4.5.3) — but it's a feature, not a gate.

---

## 2. Tech stack decisions

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node.js 20+) | Fast iteration, ecosystem, AXL HTTP-friendly |
| AXL node | **Go binary** (`gensyn-ai/axl`), HTTP on `localhost:9002` | Built locally with `make build`; runs as a sidecar process, not imported as a library. Our agents speak HTTP to it. |
| Go runtime | Go 1.25.5+ (build-only, for AXL) | Required to compile the AXL node; not used for any Parley code |
| Agent identity (network) | ed25519 keypair per agent (AXL pubkey) | Used by AXL for peer addressing; generated via `openssl genpkey -algorithm ed25519` |
| Agent identity (chain) | secp256k1 EVM wallet per agent | Separate from AXL key; used for EIP-712 signing of deal terms |
| User Agent runtime | **Hermes Agent** (Nous Research, MIT) | Telegram gateway, memory, MCP host, skills — all out of the box |
| MM Agent runtime | TypeScript daemon, no framework | Deterministic, no LLM in pricing path, fast and auditable |
| LLM (User Agent, primary) | **0G Compute Network** | Decentralized inference; Sealed Inference / TEE attestation; OpenAI-compatible API |
| LLM (User Agent, fallback) | Claude API (Sonnet 4.5) | Drop-in if 0G Compute is unavailable or hits function-calling issues |
| LLM model target | Qwen / GLM via 0G Compute marketplace | Specific model selected based on function-calling support; current candidates listed at `compute-marketplace.0g.ai` |
| 0G Compute SDK | `@0glabs/0g-serving-broker` + `openai` | Broker SDK + CLI for account/provider management; OpenAI client for inference calls |
| 0G Storage SDK | `@0gfoundation/0g-ts-sdk` + `ethers` | Indexer-based upload/download for `TradeRecord` blobs, returns Merkle root hashes |
| Smart contracts | Solidity 0.8.x + Foundry | Faster test loop than Hardhat |
| Chain | Sepolia testnet | ENS Sepolia support, public faucets, broad tool compatibility |
| Custom tools (User Agent) | MCP servers built in-tree | `axl-mcp`, `og-mcp` exposed to Hermes |
| Transaction submission (User-side) | User's wallet via Telegram Mini App + `viem`/`wagmi` | The User Agent prepares calldata for `lockUserSide`, `settle`, refunds, and fallback swaps; the user signs and submits from their own wallet. The User Agent holds no spendable funds. |
| Transaction submission (MM-side) | MM Agent's hot wallet, direct via `viem` | The MM Agent operates a Sepolia-funded hot wallet for `lockMMSide` and (by convention) `settle`. The MM operator funds this wallet. |
| Telegram interface | Hermes' built-in gateway | No `grammy` needed; Hermes handles bot commands, inline keyboards, web_app buttons natively |
| Signing surface | **Telegram Mini App** (Next.js 14) | Sandboxed page inside Telegram; wallet integration via WalletConnect |
| Wallet connectivity | `wagmi` + WalletConnect v2 | Bridges Mini App to user's MetaMask (or any WC-compatible wallet) |
| Uniswap integration | **Trading API** (HTTP) + `swap-integration` agent skill | `/quote` for reference pricing AND fallback execution; skill loaded into Hermes via agentskills.io |
| ENS identity layer | **Sepolia ENS** + text records via `viem` | Each MM Agent is `mm-{n}.parley.eth`; text records carry `axl_pubkey`, `agent_capabilities`, `reputation_root`. Solves peer discovery and two-identity binding in one mechanism. |
| Package manager | pnpm workspaces | Monorepo support |
| EVM tooling | `viem` | Modern, typed Ethereum client |
| Tokens (demo) | USDC + WETH on Sepolia | Standard pair, public faucets |

---

## 3. Repository structure

```
parley/
├── packages/
│   ├── user-agent/              # Hermes Agent setup + custom MCPs + AXL sidecar
│   │   ├── hermes-config/
│   │   │   ├── config.toml       # Hermes config: LLM provider, Telegram, MCPs
│   │   │   ├── SOUL.md           # Personality and behavior policy
│   │   │   └── skills/           # Hermes-style skills (procedural memory)
│   │   │       └── parley-trader.md
│   │   ├── mcps/                 # Custom MCP servers Hermes loads
│   │   │   ├── axl-mcp/          # Tools: broadcast_intent, send_offer, accept_offer
│   │   │   │   ├── src/index.ts
│   │   │   │   └── package.json
│   │   │   └── og-mcp/           # Tools: read_user_reputation, read_mm_reputation, write_trade_record, resolve_mm
│   │   │       ├── src/index.ts
│   │   │       └── package.json
│   │   └── axl-sidecar/          # Listens to AXL, injects offer events into Hermes
│   │       └── src/index.ts
│   ├── mm-agent/                # Pure Node.js daemon — no LLM, no framework
│   │   ├── src/
│   │   │   ├── index.ts          # Entry: AXL listener, dispatcher
│   │   │   ├── pricing.ts        # spot + spread, deterministic
│   │   │   ├── negotiator.ts     # Quote signing, accept handling, settlement
│   │   │   └── inventory.ts      # Balance tracking, trade-size caps
│   │   └── package.json
│   ├── contracts/               # Foundry project
│   │   ├── src/
│   │   │   └── Settlement.sol
│   │   ├── test/
│   │   │   └── Settlement.t.sol
│   │   ├── script/
│   │   │   └── Deploy.s.sol
│   │   └── foundry.toml
│   ├── miniapp/                 # Next.js Mini App for signing (only)
│   │   ├── app/
│   │   │   └── sign/
│   │   │       └── page.tsx      # EIP-712 signing flow
│   │   ├── lib/
│   │   │   ├── walletconnect.ts  # WC v2 setup
│   │   │   └── telegram.ts       # WebApp.sendData bridge
│   │   └── package.json
│   └── shared/                  # Shared types
│       └── src/
│           └── types.ts
│       └── src/
│           └── types.ts
├── docs/
│   ├── AGENTX_SPEC.md
│   ├── DEMO_SCRIPT.md
│   └── SUBMISSION.md
├── .env.example
├── pnpm-workspace.yaml
└── package.json
```

---

## 4. Agent specifications

### 4.0 Agent identity model

User Agents and MM Agents have **structurally different identity models**. This asymmetry is a deliberate design choice driven by what each party actually needs:

- **MM Agents need to be discovered.** Other agents have to find them, evaluate them, and address messages to them. Public, queryable identity is the right primitive: an ENS subname (`mm-N.parley.eth`) carries the wallet, AXL pubkey, capabilities, and reputation pointer in one place.
- **Users initiate.** No one needs to discover a user — the user reaches out to the bot, not the other way around. A user's identity is their wallet address. Reputation accrues against the wallet. There is no public registry of Parley users.

A user *may* opt into an ENS subname (Section 4.5.3) for human-readable identity and cross-wallet reputation portability. It is a feature, not a requirement.

#### MM Agent identity (canonical: ENS subname)

Each MM Agent has **one canonical identity (an ENS name) backed by two separate cryptographic keys**:

| Identity | Curve | Purpose | Generated by |
|---|---|---|---|
| **ENS name** | n/a | Canonical identifier for discovery and reputation lookup. Resolves to EVM wallet via standard ENS; carries other keys + metadata as text records. | Subname mint under `parley.eth` via the registration script (Section 4.5.2) |
| **EVM wallet** | secp256k1 | On-chain signing (EIP-712 deal terms, settlement transactions). Resolved by ENS `addr` lookup. | Standard wallet generation; funded from Sepolia faucet |
| **AXL pubkey** | ed25519 | Network-layer addressing on the Yggdrasil mesh. Used in `X-Destination-Peer-Id` headers when sending messages. | `openssl genpkey -algorithm ed25519 -out private.pem` |

**The ENS name is the one identifier callers reason about.** Code that needs to talk to an MM Agent receives an ENS name and resolves it via `og-mcp` (or directly via `viem`) to get whatever it needs — wallet, AXL pubkey, capabilities, reputation pointer. The EVM wallet and AXL pubkey are *derived* from the ENS name; they are not the primary handle.

**ENS records (set on each MM Agent's subname):**

| Record | Type | Value | Purpose |
|---|---|---|---|
| `addr` (standard) | address | EVM wallet | Who signs deal terms and on-chain transactions |
| `text("axl_pubkey")` | string | hex-encoded ed25519 pubkey (64 chars) | Who to send AXL messages to |
| `text("agent_capabilities")` | JSON string | `{"pairs":["USDC/WETH"],"max_size_usd":5000,"version":"1"}` | What this MM can quote |
| `text("reputation_root")` | string | 0G Storage Merkle root hash | Pointer to the latest reputation index for this MM |
| `text("avatar")` | URL (ENSIP-12) | optional avatar image | Telegram offer card display |

**Binding mechanism:**

The single locus of trust is the ENS subname owner. Whoever owns `mm-1.parley.eth` controls all of the above records. An attacker cannot rotate one key independently of the others without holding the subname.

When the User Agent receives an offer from an MM Agent:
1. It already knows the sender's ENS name (peer discovery returned it; see Section 5.0)
2. Resolves the ENS name via `viem`'s `getEnsResolver` + `text` calls — single batched lookup
3. Verifies the AXL message's `X-From-Peer-Id` matches the resolved `axl_pubkey` text record
4. Verifies the EIP-712 signature on the deal terms came from the resolved `addr`
5. Reads `reputation_root` and pulls the trade history from 0G Storage

If any of (3), (4), (5) doesn't match, the offer is rejected.

**Defense in depth:** every AXL message body still carries an EIP-712 signature over the payload. ENS provides the canonical binding *for free* — meaning we don't need a separate registry contract — but the per-message signature ensures replay protection and prevents an attacker who briefly compromised an MM's AXL key from forging settlement-relevant intent.

**MM reputation aggregation:** `og-mcp.read_mm_reputation(ens_name)` resolves the ENS name, reads `reputation_root`, fetches the index blob from 0G Storage, and returns aggregated stats. ENS is the index.

#### User identity (canonical: wallet address)

Each user is identified by their **wallet address**. There is no on-chain registry of users. The User Agent's identity boundary for a user is established at session start, not by any on-chain artifact.

Three pieces of state make up a user's identity, all of them per-user-per-session:

| Element | Lifetime | Stored where |
|---|---|---|
| **Wallet address** | The wallet itself | User's own wallet (MetaMask, Rabby, etc.) |
| **Session binding** | 24 hours from sign | Hermes' per-user in-memory state |
| **Telegram user ID ↔ wallet binding** | 24 hours, same lifetime as session | Hermes' per-user in-memory state |

**Session binding** is established when the user signs an EIP-712 message in the Mini App at session start (Section 4.5.1). The signed message authorizes the User Agent to act on behalf of `wallet 0xA…` until `<expires_at>`. Sessions are renewable (re-sign on expiry) and revocable (`/logout` clears immediately).

**Reputation aggregation:** `og-mcp.read_user_reputation(wallet_address)` queries 0G Storage for trade records where the user is `wallet_address`, runs the scoring formula (Section 7.3), returns the score plus summary stats. No ENS involved.

**Public surface:** the user's wallet address is visible to MMs they trade with (it's in the `Deal` struct on-chain) and to anyone who can read the public 0G reputation index. The wallet's full on-chain history is, of course, already public — Parley does not add or amplify this. What Parley does NOT do is publish a list of "who is a Parley user."

**Optional ENS subname (Section 4.5.3):** a user who explicitly wants a `*.parley.eth` handle can register one via `/register <handle>`. If they do, they get:
- A human-readable display name in offer cards instead of `0xA…` truncation
- Cross-wallet reputation portability (reputation tied to ENS, not wallet — survives wallet rotations)
- A public association of their handle with their wallet (the privacy tradeoff they explicitly accepted)

If they do not, none of these matter, and they trade as a wallet address.

#### Operational summary

What each agent type safeguards:

**User Agent** — has no on-chain identity of its own and no hot wallet. It safeguards only:
- `AXL_PRIVATE_KEY_PATH` (ed25519 PEM, network identity for receiving offers from MMs)
- Per-user session bindings in memory (Telegram user → wallet, with EIP-712 session signature)

The User Agent never holds spendable funds. Compromise of the AXL key allows an attacker to impersonate the User Agent on the network, but they cannot move funds — every state-changing action requires a fresh signature from the bound user wallet.

**MM Agent** — has three things:
- The ENS subname (`mm-N.parley.eth` ownership) — held by the MM operator's main wallet, not the agent's hot wallet
- `EVM_PRIVATE_KEY` (hot wallet for `lockMMSide` and `settle` submissions)
- `AXL_PRIVATE_KEY_PATH` (ed25519 PEM)

The MM Agent's hot wallet should NOT be the ENS subname owner. If the hot wallet is compromised, the operator rotates it via the subname (set new `addr` record) without losing reputation history.

**User** — has one thing:
- Their wallet (and the keys to it). Everything else is derived or session-scoped.

Session bindings expire after 24 hours; the user signs a fresh session message and continues. Bindings are revocable via `/logout` or `/reset`.

### 4.1 User Agent (Hermes Agent + custom MCPs)

**Runtime:** Hermes Agent (Nous Research, MIT). Single Hermes instance per user. Runs on a server (VPS or serverless via Modal/Daytona). Hermes hosts the Telegram gateway, persistent memory, and MCP tool layer.

**What Hermes provides for free:**
- Telegram gateway (commands, inline keyboards, message edits, web_app buttons)
- Cross-session memory (user preferences, trade history, learned counterparty patterns)
- MCP host (we plug in our custom MCPs and Hermes auto-discovers their tools)
- LLM-agnostic backend (we point Hermes at 0G Compute Network's OpenAI-compatible endpoint)
- Skills system (procedural memory the agent generates and refines over time)
- Scheduled automations (used for our polling pattern, see below)

**What we contribute on top:**
- Two custom MCP servers (`axl-mcp`, `og-mcp`) — see Section 4.3
- A small in-process settlement helper (`packages/user-agent/lib/settlement.ts`) that builds EIP-712 typed data and `lockUserSide`/`settle`/`refund`/Uniswap-fallback calldata. The helper does NOT submit transactions — it returns calldata + typed-data structures that the Mini App consumes for user-side signing and submission.
- AXL listener sidecar (~50 lines of Node.js) that bridges async network events into Hermes
- A chain-watcher subroutine inside the AXL sidecar that subscribes to Settlement contract events (`UserLocked`, `MMLocked`, `Settled`, `Refunded`) and injects them into Hermes' inbox the same way AXL events do
- A `SOUL.md` defining Parley-trader behavior: policy enforcement, evaluation criteria, when to ask the user vs. act autonomously
- Optional skill files (`skills/parley-trader.md`) capturing reusable negotiation patterns

**Responsibilities (now expressed as Hermes tool-use loops, not state machine code):**
1. Accept user intent in natural language via Telegram. Hermes parses it (LLM call to 0G Compute) and produces a structured `Intent`.
2. Call `axl-mcp.broadcast_intent(intent)` — broadcasts on AXL.
3. **Wait for offers via the sidecar pattern** (see below — the non-obvious bit).
4. For each incoming offer: call `og-mcp.read_mm_reputation(mm_ens_name)`, evaluate against policy.
5. Surface the best acceptable offer to the user via Telegram with inline `[Accept] [Reject] [Details]` keyboard.
6. On accept: call `axl-mcp.send_accept(offer)`, then prompt user to sign via Mini App (Hermes sends a `web_app` button).
7. On user-initiated accept (Telegram tap → Mini App): the User Agent prepares the EIP-712 `Deal` typed data and the `lockUserSide(deal, userSig)` calldata. The Mini App opens, the user signs the `Deal`, then immediately uses `wagmi`'s `writeContract` to submit `lockUserSide` themselves. The user pays gas; the User Agent never broadcasts anything.
8. The User Agent watches the chain for `UserLocked(dealHash)` and `MMLocked(dealHash)` events via the AXL sidecar's chain-watcher subroutine. Once both events are observed, the User Agent prompts the user to submit `settle(dealHash)` from the Mini App. (By convention the User Agent submits the settle, but in this architecture "the User Agent" means "the user, prompted by the agent".)
9. On `Settled` event: User Agent calls `og-mcp.write_trade_record(record)`, reports success to the user.
10. On timeout / no acceptable offer: User Agent prepares Uniswap fallback calldata via the Trading API and surfaces it in the Mini App. User signs and submits the swap themselves. User Agent reports the result, including the realized vs. quoted savings.

**The async event handling pattern:**

Hermes' natural model is *prompt → tool calls → response*. AXL events (incoming offers, MM lock confirmations) are not user-initiated — they arrive on the network without a triggering Telegram message. AXL itself doesn't push: its only inbound mechanism is `GET /recv`, which **must be polled**. This is the natural pattern, not a workaround.

**Strategy A — Polling (PRIMARY).** Hermes' scheduled automation runs `axl-mcp.poll_inbox()` every 2 seconds while the User Agent is in an active negotiation. The MCP calls `GET /recv`, drains the queue, and returns any new messages. Hermes processes them as if they were just received. Latency: up to 2s. Acceptable for negotiation timescales.

**Precedent:** Gensyn's own `collaborative-autoresearch-demo` uses this exact pattern — agents poll `/recv` at experiment boundaries (~5 min cadence) and broadcast results via `/send`. We're using the same pattern at higher cadence. AXL's design assumes polling.

**Strategy B — Event injection (latency optimization, not a fallback).** The AXL sidecar listens to `/recv` continuously out-of-band and, when an offer arrives, injects a system message into Hermes' inbox: *"New offer received from 0xdef…456. Evaluate."* Hermes treats it as a new turn and acts on it. Lower latency than Strategy A, but depends on a Hermes API that needs to be verified. If Hermes supports system-message injection, use it; otherwise Strategy A is sufficient.

Strategy B's availability is verified up front. Either way, the architecture works.

**Key policy fields the agent honors** (stored in Hermes memory, surfaced via `/policy`):
- `min_counterparty_rep` — reject offers from MMs below threshold
- `max_slippage_bps` — reject offers worse than this vs. spot
- `timeout_ms` — how long to collect offers before fallback
- `auto_approve_below_usd` — for autonomy tier (v1.0 always requires user approval; see Roadmap)

### 4.2 Market Maker Agent (TypeScript daemon, no LLM)

**Runtime:** Plain Node.js + TypeScript long-running process. No framework, no LLM in the pricing path. Runs as a single binary; multiple MM Agent instances with different spreads can be run simultaneously to demonstrate competitive pricing (see Roadmap).

**Why no LLM:** the MM Agent's behavior is deterministic — listen, filter, price (spot + spread), sign, send, settle. LLM round-trips would add 1-3 seconds of latency to every quote with zero quality gain. Real market makers don't run LLMs in their pricing path either: *"Parley's MM is auditable, fast, and deterministic — exactly what real liquidity providers need to be."*

**Responsibilities:**
1. Listen continuously on AXL for intents
2. Filter intents matching its inventory + risk tolerance
3. Generate quote using simple pricing model: `price = uniswap_twap * (1 + spread_bps / 10000)`
4. Sign offer with EIP-712 (deal terms + offer-specific fields), send via AXL
5. If accepted: sign deal terms separately, submit `lockMMSide(deal, mmSig)` from the MM Agent's hot wallet via `viem`
6. Wait for atomic settle (poll for `Settled` event)
7. Write trade outcome to 0G Storage

**State machine:**

```
LISTENING
  → INTENT_RECEIVED (filter passes)
  → PRICING (fetch Uniswap TWAP, apply spread, check inventory)
  → QUOTE_SENT
  → AWAITING_ACCEPT (timeout = back to LISTENING)
  → SETTLING (lock + wait for atomic settle)
  → COMPLETE → LISTENING
```

**Pricing model:** single-source spot price (Uniswap pool TWAP, e.g., 30s window) plus configurable bps spread. Does not use external CEX feeds, complex IL modeling, or hedging — those are explicit non-goals for v1.0; see Roadmap.

**Inventory:** static configuration (e.g., 10,000 USDC + 5 WETH). No rebalancing logic. Reject intents that exceed available inventory or that would push it below a minimum reserve.

**Where 0G Compute could fit on the MM side (future):** adaptive spread based on observed market conditions, smart counterparty risk assessment beyond raw reputation, multi-round negotiation logic. See Roadmap §11.4.

### 4.3 Custom MCP servers

Each MCP is a small Node.js HTTP server exposing a few tools. Hermes loads them via its MCP integration; tool calls become natural language → tool invocation transparently.

**`axl-mcp`** — bridges Hermes to the AXL peer network.

| Tool | Privileged? | HTTP mapping | Purpose |
|---|---|---|---|
| `discover_peers()` | no | Resolves all known MM ENS subnames (see Section 4.4) → returns list of `{ens_name, axl_pubkey, evm_address}` | ENS-backed peer discovery |
| `broadcast_intent(telegram_user_id, intent, intent_sig, session_sig)` | **yes** | For each peer from `discover_peers()`, `POST /send` with `X-Destination-Peer-Id: <peer's axl_pubkey>` | Fan out a user-signed intent to discovered MM Agents |
| `send_offer(intent_id, offer)` | no (MM-side) | `POST /send` with `X-Destination-Peer-Id: <originator's pubkey>` | Used by MM Agent only — reply to originator of the intent |
| `send_accept(telegram_user_id, offer_id, accept_sig, session_sig)` | **yes** | `POST /send` with `X-Destination-Peer-Id: <chosen MM's pubkey>` | Notify chosen MM their offer was accepted |
| `poll_inbox()` | no | `GET /recv` repeatedly until `204 No Content` | Drain incoming messages |
| `get_topology()` | no | `GET /topology` | Returns our pubkey, IPv6, peer state |

**`og-mcp`** — wraps 0G Storage SDK + ENS resolution for reputation reads/writes.

| Tool | Privileged? | Purpose |
|---|---|---|
| `resolve_mm(ens_name)` | no | Resolves an MM Agent's ENS name → `{evm_address, axl_pubkey, capabilities, reputation_root, avatar?}` |
| `read_mm_reputation(ens_name)` | no | Resolves ENS → reads `reputation_root` text record → fetches index from 0G → returns score and summary stats |
| `read_user_reputation(wallet_address)` | no | Queries 0G for trade records keyed by user wallet → applies scoring formula → returns score and summary stats |
| `read_trade_history(participant, limit)` | no | Last N `TradeRecord` blobs where participant is the given wallet (user) or ENS-resolved wallet (MM) |
| `write_trade_record(telegram_user_id, record, session_sig)` | **yes** | Append a `TradeRecord` to 0G Storage. The record is keyed by both participants' wallets. |
| `update_mm_reputation_root(ens_name, new_root)` | n/a (MM-side only, called from MM Agent process) | Sets `text("reputation_root")` on an MM's own subname |

#### Validation contract for privileged tools

Privileged tools enforce **server-side validation on every invocation** before performing any side effect. This is defense in depth: the SOUL.md instructs Hermes to call these tools appropriately, but the tools themselves do not trust the caller's claimed state. Four checks run on every privileged call; any failure throws `UnauthorizedError` with a specific reason code.

| # | Check | Implementation | Throws if |
|---|---|---|---|
| 1 | Session signature is valid EIP-712, signed by `session_wallet`, not expired | `verifyTypedData(SESSION_DOMAIN, sessionTypedData, session_sig) === session_wallet && expires_at > now` | Bad signature, expired session |
| 2 | Action payload (intent / accept / record) is signed by the same `session_wallet` | Recover signer from `intent_sig` / `accept_sig` over the payload, must match `session_wallet` | Action wasn't authorized by the bound wallet |
| 3 | Intent / payload fields pass schema validation | Token addresses are valid, amounts > 0, deadline > now, max_slippage_bps reasonable | Malformed payload |
| 4 | `telegram_user_id` matches the binding for `session_wallet` in the User Agent's session state | `session_state[telegram_user_id].bound_wallet === session_wallet` | Telegram user has no binding, or binding is for a different wallet |

Each privileged tool's parameter list includes the data needed for these checks: `telegram_user_id` (for #4), `session_sig` (for #1), and the action-specific signature (for #2). The User Agent's orchestration code is responsible for collecting these values from the Mini App and passing them into the tool call. Hermes never *generates* these signatures itself — it only *forwards* signatures the user produced in their wallet.

**No on-chain registration check.** Earlier drafts of this spec included a fifth check requiring the wallet to own a `*.parley.eth` subname. That requirement was dropped in v1.2 because forcing every user into a public on-chain registry was poor for privacy without proportional security benefit (see §4.0). Authorization is now established entirely by the session signature + action signature pair; ENS subnames are an opt-in user feature, not an authorization gate.

**Cost:** all four checks are cheap. Signature verification is microseconds. Total validation overhead per privileged call is well under 100ms.

**On error:** the tool throws `UnauthorizedError` with one of these reason codes:
- `SESSION_INVALID` — session signature failed verification or expired
- `INTENT_NOT_AUTHORIZED` — action signature does not match session wallet
- `MALFORMED_PAYLOAD` — schema validation failed (with sub-reason)
- `BINDING_MISMATCH` — Telegram user / wallet / session state is inconsistent

The User Agent surfaces these to the user in plain language. Most of the time, the appropriate response is to prompt the user to re-authenticate (re-sign the session binding).

### 4.4 ENS identity layer (MM Agents)

ENS is the canonical identity layer for **MM Agents**. The protocol mints subnames under a `parley.eth` root and uses ENSIP-5 text records to bind the AXL ed25519 pubkey, capabilities, and reputation pointer to each MM's name.

User Agents do not require ENS subnames; users are identified by wallet address (Section 4.0). Users who explicitly opt into a subname follow §4.5.3, but their subname uses the same schema described here and the same resolution mechanism.

**Root domain:** `parley.eth` on Sepolia ENS in v1.0; mainnet migration is on the roadmap (cost ~$5–50/year depending on the chosen name).

**Subname schema:**

```
parley.eth                   — root, owned by Parley project wallet
├── mm-1.parley.eth          — first MM Agent
│   ├── addr:               0xMM1WALLET...
│   ├── text("axl_pubkey"): "abcd1234...ef00"          (64 hex chars, ed25519)
│   ├── text("agent_capabilities"): '{"pairs":["USDC/WETH"],"max_size_usd":5000,"version":"1"}'
│   ├── text("reputation_root"): "0xMERKLEROOT..."     (0G Storage root hash)
│   └── text("avatar"):     "https://parley.app/avatars/mm-defi-pro.png"
├── mm-2.parley.eth          — second MM (optional)
└── alice.parley.eth         — opt-in user subname (Section 4.5.3, schema is a strict subset
                              — only addr is required for users; text records are optional)
```

**Resolution code (User Agent's `og-mcp.resolve_mm`):**

```typescript
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

const client = createPublicClient({ chain: sepolia, transport: http() });

async function resolveMM(ensName: string) {
  const name = normalize(ensName);
  const [addr, axlPubkey, capabilitiesJson, reputationRoot, avatar] = await Promise.all([
    client.getEnsAddress({ name }),
    client.getEnsText({ name, key: "axl_pubkey" }),
    client.getEnsText({ name, key: "agent_capabilities" }),
    client.getEnsText({ name, key: "reputation_root" }),
    client.getEnsText({ name, key: "avatar" }),
  ]);
  return {
    ens_name: ensName,
    evm_address: addr,
    axl_pubkey: axlPubkey,
    capabilities: capabilitiesJson ? JSON.parse(capabilitiesJson) : null,
    reputation_root: reputationRoot,
    avatar: avatar ?? undefined,
  };
}
```

**Discovery (User Agent's `axl-mcp.discover_peers`):**

In v1.0 the User Agent maintains a small list of known MM ENS names in env (`KNOWN_MM_ENS_NAMES=mm-1.parley.eth,mm-2.parley.eth`). It resolves each in parallel and caches them for the duration of the negotiation window.

Future work: query the ENS subgraph for all `mm-*.parley.eth` subnames, or maintain a registry contract that lists active MMs. Both are documented in the Roadmap.

**Why the verification step matters:** when an offer arrives over AXL, the User Agent verifies:
1. `X-From-Peer-Id` matches one of the resolved `axl_pubkey` records in the discovery cache → identifies the *claimed* MM
2. The EIP-712 signature on the offer's deal terms came from the resolved `addr` → confirms the EVM key holder agrees
3. The ENS record for that MM has `reputation_root` set (or accept neutral default for new MMs) → reputation check passes pre-flight

If any of (1) or (2) fails, or (3) returns a score below the user's `min_counterparty_rep` policy, the offer is rejected. The User Agent doesn't trust the message's claimed identity — it cross-references against ENS.

**ENSIP-25 alignment:** ENSIP-25 defines a standard for binding ENS names to ERC-8004 AI agent registry entries via specific text records. Parley's MM text record schema is *informally aligned* with ENSIP-25 patterns but does not require ERC-8004 registration in v1.0; full ENSIP-25 + ERC-8004 integration is on the roadmap.

**User-facing surface:** the Telegram offer card displays the MM's ENS name rather than its 0x address. Users see meaningful identities for the parties they're trading *with*; their own identity is not put on a public list.

### 4.5 Agent onboarding

User Agents and MM Agents have structurally different onboarding flows. User Agent onboarding is a *consumer flow* — conversational, in-bot, accommodates non-technical users. MM Agent onboarding is an *operator flow* — script-driven, performed once at deployment by a technical operator. The asymmetry is intentional.

#### 4.5.1 User Agent onboarding (conversational)

**Goal:** when a Telegram user sends their first message to the bot, the User Agent walks them through wallet connection and session binding *progressively* — only asking for what's missing, only when it's needed. The user's original request (e.g., *"swap 50 USDC for ETH"*) is held in memory through the auth step and resumed once they reach `READY` state.

**Per-user state machine:**

```
NEW
  ↓ (any action message arrives)
AWAITING_WALLET_CONNECT
  ↓ (user opens Mini App, connects wallet, signs session-binding EIP-712)
READY
  ↓ (original message resumed; future messages process normally)
  ↓ (24h elapsed, or /logout, or /reset)
EXPIRED → AWAITING_WALLET_CONNECT (renewal)
```

State is keyed by Telegram `user_id` and held in the single shared Hermes process's memory. There is no per-user Hermes process; per-user isolation is enforced by tool-level validation (Section 4.3) and SOUL.md instructions.

**Step 1 — Wallet connect and session binding.**

Triggered when a Telegram user with no session binding sends any action message. The bot replies:

> *"Welcome to Parley. To trade, I need to know which wallet you'll be using. Tap below to connect."*
>
> [Connect Wallet] (web_app button)

The Mini App opens, prompts WalletConnect → MetaMask, then asks the user to sign a session-binding EIP-712 message. The message reads:

> *"Authorize the Parley User Agent to act on behalf of wallet `0xA…123` from `<now>` until `<+24h>`. The agent will prepare transactions for your review and signing; it cannot move funds without your explicit approval."*

The signed message returns to the bot via `Telegram.WebApp.sendData`. The User Agent validates: signature is valid, signer matches the connected wallet, expiration is in the future, Telegram user ID matches. On success, it stores the binding in memory and transitions to `READY`.

That's the entire onboarding flow. There is no on-chain transaction, no handle to pick, no registration tx to wait for. From "I want to trade" to `READY` is one Mini App round-trip — typically under 30 seconds on a wallet that's already set up.

**Step 2 — Resume.**

The User Agent picks up the message that triggered the onboarding flow. From the user's perspective, the bot did the right thing: they asked for a trade, the bot asked them to connect once, and now their trade is being processed.

**Failure recovery.**

- **User opens Mini App but doesn't sign within 60s.** Bot prompts: *"Looks like the signature didn't go through. Try again?"*
- **User connects `0xA` but signs from `0xB`.** Agent rejects, bot replies: *"You connected `0xA…123` but signed from `0xB…456`. Please switch back, or reset with /reset."*
- **Session expires mid-trade.** Bot prompts the user to re-sign the session before any further privileged action; held context is preserved across the re-sign.
- **User sends `/logout`.** Clears the session binding, returns them to `NEW`. Useful when switching wallets.
- **User sends `/reset`.** Clears all per-user state. Documented in `/help`.

**Returning users.**

A user who came back after a previous session expired re-binds their wallet:

> *"Welcome back. Sign here to start a new trading session:"*
>
> [Sign session]

One Mini App round-trip later, they're in `READY` and their request resumes. If the user previously registered a `*.parley.eth` subname (Section 4.5.3), the bot greets them by handle.

**Informational vs. action queries.**

Not every first-time user is ready to connect a wallet. Some want to see what Parley *is* before committing. The bot handles this via SOUL.md guidance: informational queries (`/help`, `/about`, "what is parley", "how does this work") are answered without auth. Anything that would actually *do something* (broadcast intent, check reputation, view offers) triggers the wallet-connect flow. The classification is the agent's responsibility, encoded in the SOUL.md.

#### 4.5.2 MM Agent onboarding (script)

MM Agent registration is performed once per agent at deployment time, by the MM operator running a script. There is no in-bot or web-UI registration flow in v1.0.

**Where:** `packages/contracts/scripts/register-mm.ts`

**Inputs:**

| Argument | Required | Example | Notes |
|---|---|---|---|
| `--handle` | yes | `mm-1` | Becomes `mm-1.parley.eth`. Lowercase alphanumeric + hyphens, 3–20 chars. |
| `--wallet` | yes | `0xMM1WALLET…` | The MM agent's signing wallet (signs EIP-712 deal terms). Becomes the `addr` record. |
| `--axl-pubkey` | yes | `abcd1234…ef00` | Hex-encoded ed25519 pubkey (64 chars). |
| `--capabilities` | yes | `'{"pairs":["USDC/WETH"],"max_size_usd":5000}'` | JSON. Set as the `agent_capabilities` text record. |
| `--avatar` | no | `https://parley.app/avatars/mm-1.png` | Optional. Set as the `avatar` text record (ENSIP-12). |
| `--update` | no | (flag) | Idempotency — if the subname already exists, update its records instead of failing. |

**What the script does:**

The script must be run with credentials for the `parley.eth` parent wallet (the protocol operator's wallet). In a single batched transaction where possible, it:

1. Mints `<handle>.parley.eth` as a subname of `parley.eth`, owned by `--wallet`.
2. Sets `addr` record on the subname to `--wallet`.
3. Sets `text("axl_pubkey")` to `--axl-pubkey`.
4. Sets `text("agent_capabilities")` to the JSON string from `--capabilities`.
5. Sets `text("reputation_root")` to the empty string (populated after the first trade).
6. If `--avatar` was provided, sets `text("avatar")`.
7. Optionally sets the primary name (reverse record) for `--wallet` to `<handle>.parley.eth`. Recommended; makes diagnostics easier.

**v1.0 constraints:**

- **One subname per wallet.** The script will refuse to mint a second subname owned by a wallet that already owns one. This is enforced at the script level (a check before submission). MM operators running multiple MM Agents must use distinct wallets per agent.
- **Operator-revocable.** As with user subnames, the parent wallet retains the ability to revoke. MM operators are aware of this; it is documented in the deployment runbook.

**Idempotency:**

If the script is re-run with the same `--handle` and `--update` flag set, it updates the records on the existing subname rather than minting a new one. This is the supported way to rotate `axl_pubkey` (after a key rotation) or update `agent_capabilities` (when the MM expands to new pairs). Without `--update`, re-running the script with an existing handle is an error.

**Verification:**

After the script reports success, the MM operator verifies registration with:

```
viem.getEnsAddress({ name: "mm-1.parley.eth" })  // should return --wallet
viem.getEnsText({ name: "mm-1.parley.eth", key: "axl_pubkey" })  // should match --axl-pubkey
```

The MM Agent process can then be started; it will be discovered by User Agents whose `KNOWN_MM_ENS_NAMES` env var includes `mm-1.parley.eth`.

**Roadmap:** a Web UI for MM operators to register agents, manage capabilities, rotate keys, and update text records without running scripts is on the near-term roadmap. See Section 11.

#### 4.5.3 Optional user ENS subname

A user who explicitly wants a `*.parley.eth` handle may register one at any time using the `/register <handle>` command in the bot. This is a feature, not a gate — registration is never required to use Parley.

**What registration unlocks:**

- A human-readable display name in offer cards on the MM side (the user is shown to MMs as `alice.parley.eth` rather than a truncated wallet address)
- Cross-wallet reputation portability — reputation stays attached to the ENS name rather than to a specific wallet, so a user who rotates wallets retains their history
- A public association between handle and wallet (the privacy tradeoff the user explicitly accepts by registering)

**What registration does not change:**

- The session-binding mechanism remains the same. The user still signs a session-binding EIP-712 at session start; ENS doesn't replace that.
- The wallet still pays gas for trades. Registration only adds an optional identity layer; it doesn't change the asymmetric submission model.
- All four privileged-tool validation checks still apply. None of them require a registered ENS subname.

**Registration flow:**

The user types `/register <handle>` in the bot. They must already be in `READY` state (session bound). The bot validates:

- Handle format: lowercase alphanumeric + hyphens, 3–20 chars, no leading/trailing hyphen, no reserved prefix (`mm-` is reserved for MM Agents)
- Availability: `viem.getEnsAddress({ name: handle + ".parley.eth" })` must return null
- Wallet has Sepolia ETH for the registration tx (rough threshold: 0.005 Sepolia ETH)

If validation passes, the bot opens the Mini App's `/register` route. The user signs and submits a single transaction that:

1. Mints `<handle>.parley.eth` as a subname owned by the user's wallet
2. Sets the `addr` record to the user's wallet
3. Optionally sets the subname as the user's primary name (the user picks during the flow; default is yes, since reverse-resolution becomes useful for them)

The User Agent watches the chain for confirmation (~12–30 seconds on Sepolia), then updates the user's display in offer cards and starts attaching reputation history to the ENS name.

**Schema for user subnames:**

User subnames use a strict subset of the MM schema. The required record is `addr`. Other text records (`axl_pubkey`, `agent_capabilities`, `reputation_root`) do not apply to users — users don't run AXL nodes, don't quote prices, and their reputation is read directly by `og-mcp.read_user_reputation(wallet_address)` rather than via a stored root pointer. A `text("avatar")` may optionally be set for display.

**Ownership semantics (v1.0):**

User subnames, like MM subnames, are operator-revocable. The `parley.eth` parent owner can revoke a subname in cases of demonstrated abuse. This is disclosed in the registration flow:

> *"Your handle is owned by your wallet. Parley operators can revoke handles in cases of demonstrated abuse. Fuses-locked (genuinely user-owned) ownership is on the roadmap — see Section 11."*

A user who is uncomfortable with operator-revocable identity should not register an ENS subname at all; trading without one carries no functional disadvantage in v1.0 except for the human-readable display name.

**Unregistration:**

Users may release their subname at any time via `/unregister`. This removes the subname's records and surrenders ownership back to the parent. Reputation does not transfer back to the wallet automatically — once a user has been operating under an ENS handle, the trade records are keyed by ENS; releasing the subname leaves those records orphaned. Future versions may support migration. v1.0 documents the limitation honestly.

---

## 5. AXL message protocol

### 5.0 Transport layer

Every Parley message is a JSON-encoded payload carried over AXL's HTTP API:

**Sending side:**
```typescript
await fetch(`http://localhost:9002/send`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Destination-Peer-Id": recipientAxlPubkeyHex,  // 64-char hex ed25519 pubkey
  },
  body: JSON.stringify(parleyMessage),
});
```

**Receiving side (poll loop):**
```typescript
async function pollInbox(): Promise<ParleyMessage[]> {
  const messages: ParleyMessage[] = [];
  while (true) {
    const res = await fetch(`http://localhost:9002/recv`);
    if (res.status === 204) break;  // queue empty
    const body = await res.json();
    const fromPubkey = res.headers.get("X-From-Peer-Id")!;
    messages.push({ ...body, _axl_from: fromPubkey });
  }
  return messages;
}
```

**No broadcast primitive.** AXL's `/send` requires a destination peer ID. To "broadcast" an intent, the User Agent calls `axl-mcp.discover_peers()` (which resolves known MM ENS names from `KNOWN_MM_ENS_NAMES` env), then loops `POST /send` to each peer's resolved `axl_pubkey`. Peer discovery is an application-layer concern in AXL — we solve it via ENS (Section 4.4).

**Peer discovery:** ENS-backed via `parley.eth` subnames. v1.0 ships with `KNOWN_MM_ENS_NAMES=mm-1.parley.eth` (or a comma-separated list when running multiple competing MMs). Each lookup returns `{ens_name, evm_address, axl_pubkey, capabilities, reputation_root}` — everything needed to send a message AND verify any reply. The Roadmap covers ENS subgraph indexing and an on-chain registry for live discovery.

**Why not use `/mcp/` or `/a2a/` endpoints?** AXL also exposes synchronous JSON-RPC endpoints (`POST /mcp/{peer_id}/{service}` and `POST /a2a/{peer_id}`). We chose raw `/send` + `/recv` because:
- Negotiation is naturally async (offers may take time to arrive; we don't want a synchronous wait)
- The polling pattern matches `collaborative-autoresearch-demo`'s validated approach
- Raw bytes give us full control of the application envelope

A2A is a strong future option if the negotiation flow becomes more turn-based.

### 5.1 Message types

| Type | Direction | Purpose |
|---|---|---|
| `intent.broadcast` | User Agent → network | "I want to trade X for Y" |
| `offer.quote` | MM Agent → User Agent | "I'll fill at this price" |
| `offer.accept` | User Agent → MM Agent | "I take your offer" |
| `offer.reject` | User Agent → MM Agent | Optional, for politeness |
| `deal.user_locked` | User Agent → MM Agent | "I locked, your turn" |
| `deal.mm_locked` | MM Agent → User Agent | "I locked, ready to settle" |

### 5.2 Schemas (TypeScript)

```typescript
// packages/shared/src/types.ts

export interface TokenRef {
  chain_id: number;       // 11155111 = Sepolia
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface Intent {
  type: "intent.broadcast";
  id: string;             // UUID v4
  agent_id: `0x${string}`; // Wallet address
  timestamp: number;
  side: "buy" | "sell";   // Buy base with quote, or sell base for quote
  base: TokenRef;
  quote: TokenRef;
  amount: string;         // Decimal string (use `parseUnits` later)
  max_slippage_bps: number;     // 50 = 0.5%
  privacy: "public";      // v1.0: public only; semi-private/private in roadmap
  min_counterparty_rep: number; // 0.0 - 1.0
  timeout_ms: number;     // e.g., 30000
  signature: `0x${string}`;
}

export interface Offer {
  type: "offer.quote";
  id: string;
  intent_id: string;
  mm_agent_id: `0x${string}`;
  price: string;          // base/quote, decimal string
  amount: string;         // What MM commits to fill
  expiry: number;         // Unix ts (seconds)
  settlement_window_ms: number; // How long MM holds inventory after accept
  signature: `0x${string}`;
}

export interface Accept {
  type: "offer.accept";
  id: string;
  offer_id: string;
  user_agent_id: `0x${string}`;
  deal_hash: `0x${string}`; // Hash of finalized deal terms
  signature: `0x${string}`;
}

export interface DealTerms {
  user: `0x${string}`;
  mm: `0x${string}`;
  token_a: `0x${string}`; // User provides
  token_b: `0x${string}`; // MM provides
  amount_a: string;       // wei units
  amount_b: string;       // wei units
  deadline: number;       // Unix ts
  nonce: string;          // Prevents replay
}
```

### 5.3 Negotiation flow (happy path)

```
User Agent                      MM Agent
    |                              |
    |--- intent.broadcast ─────────►| (via AXL)
    |                              | (filters, prices, signs offer)
    |◄──── offer.quote ────────────|
    |                              |
    | (queries 0G for MM rep)      |
    | (evaluates offer)            |
    | (bot pings user on Telegram) |
    | (user taps ✓ Accept)         |
    |                              |
    |─── offer.accept ─────────────►|
    |                              |
    | (bot opens Mini App; user    |
    |  signs Deal terms in their   |
    |  wallet — EIP-712, off-chain)|
    |                              |
    | (User Agent receives userSig +)
    | (prepares lockUserSide calldata)|
    | (Mini App submits via user      |
    |  wallet — user pays gas)        |
    |                              |
    |── deal.user_locked ──────────►|
    |                              | (signs Deal terms with MM key)
    |                              | (submits via viem:
    |                              |  settlement.lockMMSide(
    |                              |    deal, mmSig)
    |                              |  from MM's hot wallet)
    |◄── deal.mm_locked ───────────|
    |                              |
    | (User Agent prompts user to  |
    |  submit settle from their    |
    |  wallet via the Mini App)    |
    |                              |
    | (both observe Settled event) |
    |                              |
    | (both write outcome to 0G)   |
    | (bot reports result to user) |
```

**Timeout behavior:** if `deal.mm_locked` doesn't arrive within `settlement_window_ms`, User Agent calls `settlement.refund(deal_hash)` to recover its locked tokens.

---

## 6. Settlement smart contract

### 6.1 Interface

```solidity
// packages/contracts/src/Settlement.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISettlement {
    struct Deal {
        address user;
        address mm;
        address tokenA;   // User → MM
        address tokenB;   // MM → User
        uint256 amountA;
        uint256 amountB;
        uint256 deadline;
        uint256 nonce;
    }

    enum DealState { None, UserLocked, BothLocked, Settled, Refunded }

    event UserLocked(bytes32 indexed dealHash, address indexed user);
    event MMLocked(bytes32 indexed dealHash, address indexed mm);
    event Settled(bytes32 indexed dealHash);
    event Refunded(bytes32 indexed dealHash, address indexed party);

    function dealHash(Deal calldata d) external pure returns (bytes32);
    function getState(bytes32 dealHash) external view returns (DealState);

    /// @notice Lock the user's tokenA. Anyone can call (relayer pattern);
    ///         contract verifies the user signed the deal terms via EIP-712.
    function lockUserSide(Deal calldata deal, bytes calldata userSig) external;

    /// @notice Lock the MM's tokenB. Anyone can call (relayer pattern);
    ///         contract verifies the MM signed the deal terms via EIP-712.
    function lockMMSide(Deal calldata deal, bytes calldata mmSig) external;

    /// @notice Atomic exchange. Anyone can call once both sides locked.
    function settle(bytes32 dealHash) external;

    /// @notice Refund locked tokens after deadline if settle never happened.
    function refund(bytes32 dealHash) external;
}
```

### 6.2 Settlement flow

1. Both agents agree on `Deal` terms over AXL. Each party signs EIP-712 typed data off-chain (no transaction, no gas). The User Agent prepares the typed data; the user signs it via the Mini App. The MM Agent signs its own copy in-process.
2. The user submits `lockUserSide(deal, userSig)` from their own wallet via the Mini App (`wagmi.writeContract`). User pays gas. Contract verifies the user's signature, pulls `amountA` of `tokenA` from the user via prior ERC-20 approval, marks state `UserLocked`. The User Agent never touches funds.
3. The MM Agent submits `lockMMSide(deal, mmSig)` from its own funded hot wallet via `viem`. MM operator pays gas. Contract verifies MM's signature, pulls `amountB`, marks state `BothLocked`.
4. Once both lock events are observed, the User Agent prompts the user to submit `settle(dealHash)` from the Mini App. (`settle` is permissionless; the MM Agent could also call it from its hot wallet — by convention we prompt the user so the User Agent never needs spendable balance.)
5. If `block.timestamp > deadline` and state is `UserLocked` only, anyone can call `refund(dealHash)`. The User Agent prompts the user to submit refund from the Mini App; this is the path that recovers user funds when an MM never locked. The MM Agent watches for this same condition as a courtesy and may submit refund itself if the user's session has expired.

### 6.3 Security notes

- Use `SafeERC20` from OpenZeppelin for all token transfers
- Require `deadline > block.timestamp` on lock calls
- Use `nonce` to prevent replay of cancelled deals
- Reentrancy guard on settle/refund (CEI pattern)
- Cap `amountA` / `amountB` to prevent griefing via dust deals (future)
- **Out of scope for v1.0:** dispute resolution, partial fills, cross-chain locks

### 6.4 EIP-712 typed data

Both User and MM sign the same `Deal` struct off-chain. The contract recovers signer address via `ECDSA.recover` and checks it equals `deal.user` or `deal.mm` respectively.

**Domain separator:**

```solidity
EIP712Domain({
  name: "Parley",
  version: "1",
  chainId: 11155111,            // Sepolia
  verifyingContract: <Settlement address>
})
```

**Type hash:**

```solidity
bytes32 constant DEAL_TYPEHASH = keccak256(
  "Deal(address user,address mm,address tokenA,address tokenB,"
  "uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce)"
);
```

**Mini App signing call (TypeScript via wagmi/viem):**

```typescript
const signature = await walletClient.signTypedData({
  domain: {
    name: "Parley",
    version: "1",
    chainId: 11155111,
    verifyingContract: SETTLEMENT_CONTRACT,
  },
  types: {
    Deal: [
      { name: "user", type: "address" },
      { name: "mm", type: "address" },
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "Deal",
  message: deal,
});
```

The user's wallet (MetaMask, Rabby, etc.) renders this typed data natively as a structured prompt — they see token addresses, amounts, deadline, counterparty — not opaque hex.

### 6.5 Pre-trade ERC-20 approvals

Because `lockUserSide` pulls tokens from the user via `transferFrom`, the user must have approved the Settlement contract to spend their tokenA *before* signing any deal. This is a one-time on-chain transaction per token pair.

The bot detects insufficient allowance during onboarding and prompts:
> *"To trade USDC, allow the Parley settlement contract to spend it. This is a one-time approval. Tap to sign."*

User approves via Mini App → MetaMask → on-chain transaction. Allowance is cached and reused for all future trades.

---

## 7. 0G Storage schema

### 7.1 Reputation record

Written after every settlement attempt (success or failure) by both agents (cross-verified later by reputation indexer).

```typescript
interface TradeRecord {
  trade_id: string;       // Same as deal_hash
  timestamp: number;      // Settlement or timeout time
  user_agent: `0x${string}`;
  mm_agent: `0x${string}`;
  pair: string;           // "USDC/WETH"
  amount_a: string;       // wei
  amount_b: string;       // wei
  negotiated_price: string; // Decimal string

  // Outcome
  user_locked: boolean;
  user_locked_at: number;
  mm_locked: boolean;
  mm_locked_at: number;
  settled: boolean;
  settlement_block: number | null;

  // Default attribution (none if settled, or which party defaulted)
  defaulted: "none" | "user" | "mm" | "timeout";

  // Cross-signature
  user_signature: `0x${string}`;
  mm_signature: `0x${string}` | null;
}
```

### 7.2 Storage pattern

0G Storage's TypeScript SDK is blob-oriented: `indexer.upload(file, RPC_URL, signer)` returns a Merkle **root hash**. Records aren't keyed by path — they're keyed by content hash. Two layers we use:

**Trade records (blob layer):**

```typescript
import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";

const RPC_URL = "https://evmrpc-testnet.0g.ai";
const INDEXER_RPC = "https://indexer-storage-testnet-turbo.0g.ai";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(process.env.OG_PRIVATE_KEY!, provider);
const indexer = new Indexer(INDEXER_RPC);

// Write a TradeRecord
const blob = new MemData(new TextEncoder().encode(JSON.stringify(record)));
const [rootHash, err] = await indexer.upload(blob, RPC_URL, signer);
if (err) throw err;
// rootHash is the canonical reference to this TradeRecord
```

**Per-agent index** — we maintain a small mapping from agent address to a list of root hashes. Two implementation options:
- **Simple:** in-memory cache in the `og-mcp` server, rebuilt from a known seed root hash on startup
- **Robust:** a separate "index blob" per agent, replaced on each new trade. The latest index blob's root hash is stored in a tiny on-chain registry (or reconstructed by scanning since a known epoch)

v1.0 ships the simple approach: keep an in-memory `Map<agentAddress, rootHash[]>` in the `og-mcp` process, persist to a local JSON file on shutdown. The on-chain registry pattern is on the roadmap.

**Read pattern:**

```typescript
// Download a TradeRecord by root hash, verify Merkle proof
const tmpPath = `/tmp/${rootHash}.json`;
const err = await indexer.download(rootHash, tmpPath, /* verify */ true);
const record: TradeRecord = JSON.parse(await fs.readFile(tmpPath, "utf-8"));
```

The `verify=true` flag makes the SDK reconstruct the Merkle proof against the indexer's commitment — guaranteeing the bytes we got back are the bytes that were uploaded.

### 7.3 Reputation score (computed, not stored)

Reputation in Parley is *computed* on demand by aggregating `TradeRecord` blobs read from 0G Storage. The score is bounded in `[-0.5, 1.0]`. Fresh accounts default to `0.0` (neutral) until they have history.

**Two scoring functions** — User Agents and MM Agents are scored differently because their failure modes differ.

**Lookup keys:**
- **User reputation** is keyed by `wallet_address`. Trade records contain the user's wallet; aggregation queries `og-mcp.read_user_reputation(wallet_address)`. If the user has registered an opt-in `*.parley.eth` subname (Section 4.5.3), reputation is keyed by ENS name instead, providing portability across wallet rotations. Both lookup paths are supported by the same scoring function — only the input changes.
- **MM reputation** is always keyed by ENS name. Trade records contain the MM's `ens_name`; aggregation queries `og-mcp.read_mm_reputation(ens_name)`. MMs are required to have ENS subnames (Section 4.5.2), so this path has no fallback.

```typescript
// packages/user-agent/mcps/og-mcp/lib/reputation.ts

const SMOOTHING = 5;             // Bayesian smoothing constant — see note below
const FAILED_ACCEPT_WEIGHT = 0.5; // Penalty per failed acceptance
const MM_TIMEOUT_WEIGHT = 0.5;    // Penalty per MM lock timeout

interface UserStats {
  settlements: number;
  failed_acceptances: number;  // User accepted offer but never signed lockUserSide
  // On-chain reverts (e.g., insufficient approval) are NOT counted in v1.0 — the signal is ambiguous.
}

interface MMStats {
  settlements: number;
  mm_timeouts: number;         // MM accepted, sent offer, user accepted, but MM never submitted lockMMSide before deadline
}

export function computeUserScore(s: UserStats): number {
  const denom = s.settlements + s.failed_acceptances + SMOOTHING;
  return (s.settlements - FAILED_ACCEPT_WEIGHT * s.failed_acceptances) / denom;
}

export function computeMMScore(s: MMStats): number {
  const denom = s.settlements + s.mm_timeouts + SMOOTHING;
  return (s.settlements - MM_TIMEOUT_WEIGHT * s.mm_timeouts) / denom;
}
```

**Worked examples:**

| Scenario | Score | Interpretation |
|---|---|---|
| Fresh account, 0 trades | `0 / 5 = 0.0` | Neutral; no history yet |
| 1 successful trade | `1 / 6 ≈ 0.17` | Slightly positive; smoothing keeps early scores honest |
| 10 successful, 0 failures | `10 / 15 ≈ 0.67` | Solid track record |
| 50 successful, 0 failures | `50 / 55 ≈ 0.91` | Strong reputation |
| 10 successful, 2 failed acceptances | `(10 - 1) / 17 ≈ 0.53` | Some history of flaking, lower trust |
| 0 successful, 3 failed acceptances | `(0 - 1.5) / 8 ≈ -0.19` | Active negative signal — never completes trades |

**What counts as "failed acceptance" (User scoring):**

- ✅ User accepted offer in Telegram but never signed the `Deal` in the Mini App within the deal deadline
- ✅ User signed but cancelled the `lockUserSide` submission in their wallet
- ❌ User submitted `lockUserSide` but the tx reverted on-chain — *not counted in v1.0*. The signal is ambiguous (RPC failure, insufficient approval, network issue, malicious vs. mistake) and we'd rather under-penalize than punish honest users for chain conditions.

**What counts as "MM timeout" (MM scoring):**

- ✅ MM sent an offer, user accepted, MM never submitted `lockMMSide` before the deal deadline → user had to refund
- ❌ MM didn't send any offer in response to an intent (this isn't a commitment, just disinterest)

**Calibration note:** these weights and the smoothing constant are v1.0 defaults. They will be retuned based on observed behavior once we have meaningful data. Specifically:
- `SMOOTHING` (5) — controls how quickly fresh accounts converge to their "true" score. Higher = more conservative early ratings.
- `FAILED_ACCEPT_WEIGHT`, `MM_TIMEOUT_WEIGHT` (0.5 each) — control how much a single failure costs. May need to be higher in production where each failure is more economically damaging.

**MM filtering:** MM Agents reject offers from User Agents below `min_counterparty_rep` (default `0.0` in v1.0 — accept neutral and above; configurable). User Agents filter MM offers below their own `min_counterparty_rep` policy field (default `0.5`). Different defaults reflect that MM Agents are the more cautious side (their funds are at risk for longer windows).

**v1.0 scope:** read records, compute score on-the-fly, cache in agent memory for the session. No on-chain reputation oracle.

---

## 8. Transaction submission

Parley uses an **asymmetric submission model**. The User Agent never submits transactions or holds spendable funds. The MM Agent submits its own transactions from a funded hot wallet operated by the MM operator.

### 8.1 What each party submits

| Action | Submitter | Pays gas |
|---|---|---|
| ENS subname registration (optional) | User's wallet (via Mini App, only if user runs `/register`) | User |
| ENS text records (user side, optional) | User's wallet (via Mini App, after registration) | User |
| `lockUserSide(deal, userSig)` | User's wallet (via Mini App) | User |
| `settle(dealHash)` | User's wallet (via Mini App, by convention) | User |
| `refund(dealHash)` | User's wallet (Mini App) for recoveries; MM Agent hot wallet as courtesy fallback | Whoever submits |
| Uniswap fallback swap | User's wallet (via Mini App) | User |
| `lockMMSide(deal, mmSig)` | MM Agent's hot wallet | MM operator |
| MM ENS registration / text records | MM operator's wallet (offline script — see Section 4.5.2) | MM operator |
| 0G Storage writes | Whichever agent is writing (User Agent for trade records on the user side, MM Agent for theirs) | Pays in OG tokens via 0G SDK, not Sepolia gas |

### 8.2 User Agent — calldata builder, not submitter

The User Agent's settlement helper at `packages/user-agent/lib/settlement.ts` does NOT use `walletClient.writeContract`. It returns calldata + EIP-712 typed-data structures that the Mini App consumes for user-side signing and submission.

```typescript
// packages/user-agent/lib/settlement.ts
import { encodeFunctionData } from "viem";

export interface PreparedLockUserSide {
  // EIP-712 typed data the user signs to authorize the deal
  typedData: TypedDataDefinition;
  // Calldata + target the user submits via wagmi.writeContract once they have userSig
  callTarget: { address: `0x${string}`; abi: typeof settlementAbi; functionName: "lockUserSide" };
  // Args without the signature — Mini App appends userSig before submitting
  argsWithoutSig: [Deal];
}

export function prepareLockUserSide(deal: Deal): PreparedLockUserSide {
  return {
    typedData: buildDealTypedData(deal),
    callTarget: {
      address: SETTLEMENT_CONTRACT_ADDRESS,
      abi: settlementAbi,
      functionName: "lockUserSide",
    },
    argsWithoutSig: [deal],
  };
}
```

The Mini App receives this structure, prompts the user to sign `typedData`, then submits `lockUserSide(deal, userSig)` via `wagmi`. The User Agent only watches the chain for the resulting `UserLocked` event via its chain-watcher.

### 8.3 MM Agent — direct submitter

The MM Agent submits `lockMMSide` and (sometimes) `settle` and `refund` from its own hot wallet using `viem`. Pattern:

```typescript
// packages/mm-agent/src/settlement.ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.MM_EVM_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: sepolia, transport: http() });

export async function lockMMSide(deal: Deal, mmSig: `0x${string}`) {
  const hash = await walletClient.writeContract({
    address: SETTLEMENT_CONTRACT_ADDRESS,
    abi: settlementAbi,
    functionName: "lockMMSide",
    args: [deal, mmSig],
  });
  return await waitForReceiptWithRetry(hash);
}
```

`waitForReceiptWithRetry` is a 15-line helper with exponential backoff (3 attempts, 1s/2s/4s). All the reliability we need on Sepolia.

### 8.4 MM Agent hot wallet funding

The MM Agent's hot wallet needs Sepolia ETH for gas. Each `lockMMSide` + `settle` round-trip costs roughly 0.001 Sepolia ETH, so 0.05 Sepolia ETH funds ~50 trades — plenty of headroom for any demo or test cycle. The MM operator funds the wallet once from the public Sepolia faucet and tops it up as needed.

The hot wallet is intentionally distinct from the ENS subname owner wallet (Section 4.0). If the hot wallet is compromised or runs dry, the operator rotates it via the ENS `addr` record without losing reputation history.

### 8.5 Why no User Agent hot wallet

This is a deliberate departure from a "relayer pattern" where an agent pays gas on the user's behalf. Three reasons:

- **Trust model honesty.** The User Agent is the user's representative, not their treasury. Decoupling authority from funds makes the trust boundary explicit: the agent prepares actions, the user authorizes them with both a signature *and* a transaction submission.
- **Operational simplicity.** No agent ETH balance to monitor, refill, or worry about draining. The User Agent is essentially free to run except for 0G Compute calls.
- **Anti-abuse by construction.** Spam vectors are economically bounded by the spammer's own resources. A user can only spam themselves into bankruptcy.

The asymmetry with the MM Agent is intentional: MM operators are technical, motivated parties with a business reason to maintain a funded hot wallet, and their settlement obligations are predictable. Users have neither the technical context nor the motivation to operate gas-paying infrastructure.

---

## 9. Uniswap integration — fallback execution + reference pricing

Uniswap shows up in two places in Parley's flow: as the **fallback liquidity source** when no peer offer arrives, and as the **reference price** the User Agent uses to evaluate peer offers ("this peer is X% better than Uniswap"). Both go through the same Trading API.

### 9.1 Fallback execution path

**Trigger:** User Agent's `COLLECTING_OFFERS` state times out without an acceptable offer (or all offers fail policy checks).

**Approach:** the **Uniswap Trading API** — a hosted HTTP service that returns ready-to-submit calldata. Avoids hand-rolling Universal Router calldata or managing pool routing logic locally.

**Three endpoints:**

| Endpoint | Purpose | Returns |
|---|---|---|
| `/check_approval` | Verify Permit2 approval for input token | Approval tx if needed, otherwise OK |
| `/quote` | Best-route quote across v2/v3/v4/UniswapX | Expected output, route, signed payload |
| `/swap` | Build the actual transaction | Fully-formed calldata + value |

**Sepolia universal router (returned by API in calldata `to`):** `0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b`

**Auth:** free API key from `developers.uniswap.org/dashboard`. Goes in the `x-api-key` header.

**Implementation sketch:**

```typescript
// packages/user-agent/lib/uniswap-fallback.ts

const UNISWAP_API = "https://api.uniswap.org";
const HEADERS = {
  "x-api-key": process.env.UNISWAP_API_KEY!,
  "content-type": "application/json",
};

export interface PreparedFallbackSwap {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  approvalRequired?: { spender: `0x${string}`; token: `0x${string}` };
}

async function prepareFallbackSwap(
  intent: Intent,
  userAddress: `0x${string}`
): Promise<PreparedFallbackSwap> {
  // 1. Check Permit2 approval; if required, the Mini App handles it before the swap
  const approvalCheck = await fetch(`${UNISWAP_API}/v2/check_approval`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      walletAddress: userAddress,
      token: intent.quote.address,
      amount: parseUnits(intent.amount, intent.quote.decimals).toString(),
      chainId: 11155111,
    }),
  }).then(r => r.json());

  // 2. Get a quote (also useful as a reference price — see Section 9.2)
  const quote = await fetch(`${UNISWAP_API}/v2/quote`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      type: "EXACT_INPUT",
      tokenInChainId: 11155111,
      tokenOutChainId: 11155111,
      tokenIn: intent.quote.address,
      tokenOut: intent.base.address,
      amount: parseUnits(intent.amount, intent.quote.decimals).toString(),
      slippageTolerance: intent.max_slippage_bps / 100, // bps → percentage
      swapper: userAddress,
      protocols: ["V2", "V3", "V4"],   // exclude UNISWAPX for sub-$300 trades
    }),
  }).then(r => r.json());

  // 3. Build the transaction
  const swap = await fetch(`${UNISWAP_API}/v2/swap`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ quote: quote.quote, signature: null }),
  }).then(r => r.json());

  // 4. Return calldata for the Mini App to submit from the user's wallet
  return {
    to: swap.swap.to as `0x${string}`,
    data: swap.swap.data as `0x${string}`,
    value: BigInt(swap.swap.value || 0),
    approvalRequired: approvalCheck.approval
      ? { spender: approvalCheck.approval.spender, token: intent.quote.address }
      : undefined,
  };
}
```

The User Agent calls `prepareFallbackSwap`, then surfaces a "Swap on Uniswap (fallback)" button in Telegram. Tap → Mini App opens → if `approvalRequired`, user signs+submits an approval first → user submits the swap from their own wallet via `wagmi.sendTransaction`. User pays gas. The User Agent watches the chain for the swap result and reports back.

**Implementation notes:**
- `protocols: ["V2", "V3", "V4"]` — exclude UniswapX (300 USDC mainnet / 1,000 USDC L2 minimums make it inapplicable to our $5–$50 demo trades)
- Single-chain only (`tokenInChainId === tokenOutChainId === 11155111`)
- No bridging
- No Uniswap v4 hooks construction (we *route through* v4 if the API picks it, but we don't deploy our own)

### 9.2 Quote as reference price (the "savings" comparison number)

The same `/quote` endpoint that powers fallback also gives us a real-time reference price for evaluating peer offers. When the User Agent receives an offer from an MM Agent, it calls `/quote` against Uniswap and compares.

```typescript
// In offer evaluation, after receiving a peer offer:
const uniswapQuote = await getUniswapQuote(intent);
const uniswapEffectivePrice = uniswapQuote.amountOut / intent.amount;
const peerEffectivePrice = peerOffer.amountOut / intent.amount;
const savingsBps = (peerEffectivePrice - uniswapEffectivePrice) / uniswapEffectivePrice * 10000;
```

The savings number flows into the Telegram offer card, alongside the ENS-resolved identity (Section 4.4):

> *Offer from `mm-defi-pro.parley.eth`: 0.0252 ETH for 50 USDC (+0.6% better than Uniswap) — reputation 0.94 across 27 trades*

Two reasons this matters:
- **Demo:** judges immediately see the value Parley creates over the on-chain alternative — a *measured* number, not hand-waved
- **Policy enforcement:** the User Agent can reject any peer offer that's worse than Uniswap (`savingsBps < 0`) automatically, regardless of reputation. Sane default.

**Caching note:** call `/quote` once at the start of `COLLECTING_OFFERS` (when the intent is broadcast) and cache for the duration of the negotiation window. Don't re-quote per peer offer — it'd burn rate limits and the price won't move much in 30s anyway.

### 9.3 Uniswap AI skill in Hermes

Uniswap publishes the `swap-integration` skill via the **agentskills.io** standard. Hermes Agent claims agentskills.io compatibility. We install Uniswap's official guidance directly into Hermes' skills directory:

```bash
cd packages/user-agent/hermes-config/skills
npx skills add Uniswap/uniswap-ai --skill swap-integration
```

This gives the User Agent Uniswap's official patterns and constraints when it reasons about fallback execution. The runtime impact is modest, but the skill ensures Parley's User Agent stays aligned with Uniswap's evolving guidance for agent-driven swaps.

Build-time use: same skill loaded into our coding-agent helps us write the integration faster.

---

## 10. User interface — Telegram bot + signing Mini App

The user-facing surface has two parts:
- **Telegram bot** — primary conversational interface. All policy setting, intent submission, status updates, offer review, and final results happen here.
- **Telegram Mini App** — sandboxed Web App that opens inside the Telegram client. Bridges to the user's wallet (MetaMask / any WalletConnect-compatible wallet) for the flows it handles: session binding (EIP-712 signing), peer-trade settlement (signature + transaction submission), Uniswap fallback (transaction submission), and — only if the user opts in — ENS subname registration. Section 10.2 details the per-flow paths.

The user installs nothing Parley-specific. They need only Telegram (where the bot lives) and a wallet they already use (MetaMask, Rabby, etc.).

### 10.1 Telegram interface (handled by Hermes Agent)

**Stack:** Hermes Agent's built-in Telegram messaging gateway. No `grammy`, no separate bot package.

Hermes' Telegram support handles bot commands, message editing, inline keyboards, and `web_app` button rendering natively. We configure it via `hermes-config/config.toml`:

```toml
[messaging.telegram]
enabled = true
bot_token = "$TELEGRAM_BOT_TOKEN"
# allowed_users not set — multi-tenant; onboarding is open to any Telegram user
# (per-user authorization is enforced by the privileged-tool validation contract — see Section 4.3)

[llm]
provider = "openai"           # 0G Compute speaks OpenAI-compatible
base_url = "$ZG_COMPUTE_ENDPOINT"
api_key = "$ZG_COMPUTE_KEY"
model = "qwen3.6-plus"        # or "glm-5"

[mcp.servers]
axl = { command = "node", args = ["mcps/axl-mcp/dist/index.js"] }
og = { command = "node", args = ["mcps/og-mcp/dist/index.js"] }
```

**Commands** (Hermes routes these to its prompt-driven handler; the SOUL.md and skills define behavior):

| Command | Behavior |
|---|---|
| `/start` | Welcome message; explains Parley. If the user has no session, the next action message triggers the onboarding flow (Section 4.5.1). |
| `/policy` | View / update default policy (slippage, min counterparty rep, timeout) — stored in Hermes memory, scoped per Telegram user |
| `/balance` | Show wallet address and on-chain balances (USDC, WETH, ETH) for the bound wallet |
| `/history` | Last 10 trades with status and Etherscan links — pulled from 0G via `og-mcp` |
| `/register <handle>` | Optionally register `<handle>.parley.eth` to your wallet (Section 4.5.3). Not required for trading. |
| `/unregister` | Release a previously-registered subname. Does not migrate reputation; see Section 4.5.3. |
| `/logout` | Clear the current session binding (forces re-binding on next action). Does not affect ENS registration. |
| `/reset` | Clear all per-user state in the Hermes process. Use when stuck in a bad state during onboarding. |
| `/help` | Show command list |

**Conversational intent submission (no command needed):**

User types free-form: "Swap 50 USDC for ETH, max 0.5% slippage."

If the user is not in `READY` state, the User Agent first walks them through the onboarding flow (Section 4.5.1), holding the message for replay once they're authenticated.

Once in `READY`: Hermes (via 0G Compute) parses the message into a structured `Intent`. If ambiguous, Hermes asks one clarifying question. If clear, Hermes confirms terms with the user via inline keyboard:

> *I'm going to broadcast: sell 50 USDC for ETH, max 0.5% slippage, 30s timeout. [✓ Confirm] [✕ Cancel]*

After confirmation, Hermes opens the Mini App for the user to sign the intent payload (an EIP-712 signature over the `Intent` struct). The signature comes back via `Telegram.WebApp.sendData`. Hermes then calls `axl-mcp.broadcast_intent(telegram_user_id, intent, intent_sig, session_sig)` — the privileged-tool validation contract (Section 4.3) verifies all five checks before any AXL message is sent.

**Live status updates:**

Hermes edits a single status message in place rather than spamming new messages. Telegram displays an "edited" indicator.

```
Initial:  "Broadcasting on AXL..."
Edit 1:   "Broadcasting on AXL ✓\nListening for offers..."
Edit 2:   "Broadcasting on AXL ✓\nListening for offers...\n1 offer received from 0xdef...456"
```

**Inline keyboards** for all confirmations (no free-text required):
- Offer accept/reject: `[✓ Accept] [✕ Reject] [Details]`
- Final terms confirm: `[✓ Confirm and sign] [✕ Cancel]`
- Trade complete: `[View on Etherscan ↗] [New trade]`

**Mini App invocation:** Hermes' Telegram gateway supports `web_app` buttons via its messaging API. When a wallet signature is needed (one-time approvals, EIP-712 deal signing), Hermes sends a button pointing at our Mini App URL, including a server-signed JWT carrying the deal payload.

### 10.2 Telegram Mini App (`packages/miniapp`)

**Stack:** Next.js 14 App Router + `wagmi` + WalletConnect v2 + `viem`. Hosted on Vercel.

The Mini App is the central signing and submission surface. It handles four distinct flows, dispatched by URL path:

| Path | Trigger | Action |
|---|---|---|
| `/connect` | First message from new Telegram user | WalletConnect → user signs session-binding EIP-712 → Mini App returns signature to bot |
| `/register` | User runs `/register <handle>` (opt-in only) | Validate handle availability → submit subname mint tx from user wallet → wait for confirmation → return tx hash to bot |
| `/sign` | User accepted a peer offer | Sign EIP-712 `Deal` → submit `lockUserSide(deal, sig)` from user wallet → return tx hash to bot. (Single-page flow; the signing and submission happen sequentially without the Mini App closing in between.) |
| `/swap` | Fallback to Uniswap | Optionally submit Permit2 approval → submit swap calldata from user wallet → return tx hash to bot |
| `/settle` | Both lock events observed; user prompted to settle | Submit `settle(dealHash)` from user wallet → return tx hash to bot |
| `/refund` | Deadline expired with only User-side locked | Submit `refund(dealHash)` from user wallet → return tx hash to bot |

**Common shape across all flows:**

1. Mount: parse parameters and JWT from URL, verify JWT against bot's public key.
2. If wallet not connected, show WalletConnect modal.
3. Render context (deal terms / handle to register / swap details) for user to review.
4. On user confirmation, perform the flow's signing and/or submission step(s) using `wagmi`. The user's wallet handles the actual signing UX.
5. Once the operation is complete, call `Telegram.WebApp.sendData(JSON.stringify({ kind, ...payload }))` with the result and close.

**`/sign` flow detail (the two-step lock case):**

The `lockUserSide` flow is the only one that requires both a signature and a transaction submission in the same Mini App session. It must complete both before closing:

1. User reviews deal summary.
2. User taps "Sign and Lock". Mini App calls `signTypedData` on the EIP-712 `Deal` struct.
3. Wallet returns `userSig`. Mini App immediately calls `writeContract({ functionName: "lockUserSide", args: [deal, userSig] })` from the same connected wallet.
4. Wallet shows a transaction confirmation dialog (this costs gas). User confirms.
5. Mini App waits for the tx hash, then calls `sendData({ kind: "lock_submitted", txHash, dealId })` and closes.

If the user cancels at step 2 (signature) or step 4 (submission), the Mini App returns `{ kind: "cancelled" }` and the bot prompts the user to retry or abandon.

**ERC-20 approvals:** the first time a user trades a given token, they need to approve the Settlement contract (and Uniswap's Permit2, for fallback). Approvals are surfaced as separate one-time Mini App flows triggered before the first lock or swap. Approval txs cost gas and are paid by the user.

### 10.3 Hermes ↔ Mini App ↔ chain flow

The Mini App is the only out-of-Hermes component on the user-facing path. The interaction is event-driven through three channels: `web_app` buttons (Hermes → Mini App), `Telegram.WebApp.sendData` (Mini App → bot), and chain events (chain → AXL sidecar → Hermes).

**Example: peer-matched trade (`/sign` flow):**

1. Hermes decides a signature is needed (user accepted an offer). It crafts a `web_app` button URL: `https://parley.app/sign?dealId=...&token=<JWT>`. The Mini App receives the deal terms and pre-built `lockUserSide` calldata via the JWT-signed payload.
2. User taps button → Telegram opens Mini App → wallet flow proceeds as in 10.2 → Mini App submits `lockUserSide` from user's wallet → Mini App returns `{ kind: "lock_submitted", txHash, dealId }` to bot.
3. Hermes receives the `web_app_data` event with the tx hash. It updates the user's Telegram message: *"Lock transaction sent. Waiting for confirmation…"*
4. AXL sidecar's chain-watcher observes the `UserLocked` event on-chain, injects "user_locked" into Hermes' inbox. Hermes updates the user: *"Your side is locked. Waiting for the MM…"*
5. When `MMLocked` is observed, Hermes prompts the user to submit settle (`/settle` flow). User taps, Mini App opens, submits, closes.
6. When `Settled` is observed, Hermes reports completion.

No bridge code between bot and User Agent — Hermes *is* the User Agent. Internal events (offer received, MM locked, settled) all flow through Hermes' inbox via the AXL sidecar.

### 10.4 What the bot does NOT do

- **Hold private keys.** Ever. Signing happens in the user's wallet, period.
- **Auto-approve trades.** Every settlement requires explicit user tap + signature.
- **Run AXL on the user's behalf.** The User Agent runs AXL. The bot is just I/O.
- **Publish user identity on-chain unless they explicitly opt in.** Users transact as wallet addresses by default. The only path to an on-chain `*.parley.eth` user identity is `/register <handle>` (Section 4.5.3), which the user runs intentionally.

---


## 11. Roadmap

This section names work that is **not implemented in version 1.0**, organized by likely sequence rather than priority.

### 11.1 Near-term (intended next)

- **MM Agent self-service registration via Web UI.** Replace the script-based MM registration flow (Section 4.5.2) with a Web UI for MM operators to register agents, manage capabilities, rotate keys, and update text records. Required before broadening the MM operator pool beyond initial collaborators.
- **EIP-7702 session keys.** Replace the per-trade signature flow with a session-scoped delegation: at session start, the user signs a time-bounded, scope-bounded authorization once; subsequent intents within the session don't require fresh signatures. Cuts the signature count from three per trade down to one or two. Settlement transactions still require explicit user submission. Compatible with the current architecture as a layer on top.
- **Fuses-locked subname ownership migration.** Migrate Parley subnames from operator-revocable to genuinely owner-controlled via NameWrapper fuses (`CANNOT_BURN_FUSES`, `PARENT_CANNOT_CONTROL`). Applies to both MM subnames and opt-in user subnames. Trades operator-side abuse-handling capability at the identity layer for stronger trust guarantees; abuse mitigation moves entirely to reputation and application-layer mechanisms.
- **Expand opt-in user ENS support.** Build a richer feature set around opt-in user subnames: profile customization (avatar, bio), reputation migration on `/unregister`, ENS-based portability across User Agent deployments, integration with mainstream ENS profile tooling. The optional ENS path was kept minimal in v1.0; if it sees adoption, this is where it grows.
- **Encrypted reputation history.** Make `TradeRecord` blobs in 0G Storage encrypted to the participants (using their wallet keys for ECIES or similar), with only the aggregate score being publicly readable. Addresses the residual privacy concern that wallet-keyed reputation still leaks per-trade history. v1.0 reputation records contain participant wallets in plaintext.
- **Two competing MM Agents in routine operation.** Multiple MM Agent instances with distinct spreads and inventory profiles, running continuously to demonstrate competitive pricing. Same MM Agent code, different config.
- **Auto-approve below threshold.** A `/policy` setting `auto_approve_below_usd` that lets the User Agent skip the explicit-approval step for small, high-confidence trades, while still requiring a session-scoped signature obtained at session start. Closes the loop on autonomous-but-supervised execution.
- **Agentic ID for MM Agents.** Mint each MM as an [ERC-7857](https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857) NFT on 0G Galileo carrying encrypted "intelligent data" (system prompt, model, capabilities) plus TEE/ZKP-verifiable proofs. Reputation keys on `tokenId` instead of wallet, so identity persists across operator key rotations. Compatible with [ENSIP-25](https://docs.ens.domains/ensip/25) for cross-binding to ENS names.
- **Light demo client.** A lightweight web-based or read-only Telegram client that lets visitors observe an in-progress trade without trading themselves — useful for documentation, demos, and onboarding videos. Unlike a guest-trading mode (which would compromise the identity model), this is purely observational.

### 11.2 Cross-chain and privacy

- **Cross-chain settlement** — extend the Settlement contract to handle locks across chains, likely via [NEAR Intents](https://www.near.org/intents) for the cross-chain leg while keeping Parley's Ethereum-native settlement as primary.
- **Privacy tiers** — semi-private (offer details encrypted to specific peers) and fully private (RFQ visible only to invited counterparties) layered on top of AXL's existing point-to-point encryption.
- **Multi-round negotiation** — replace the current single RFQ → quote → accept flow with iterative price discovery (counter-offers, range narrowing).

### 11.3 Settlement and risk

- **Partial fills.** Today, a Deal is all-or-nothing. Splitting an intent across multiple MMs (or partially filling against on-chain liquidity) is a meaningful UX win for larger trades.
- **Dispute resolution.** A challenge period after settlement where either party can flag a deviation, with on-chain arbitration. v1.0 trusts the EIP-712 signatures and atomic settlement to prevent disputes — sufficient for the initial scope but not for production at scale.
- **Account abstraction (ERC-4337)** — replace the current EOA pattern with smart wallets, which simplifies session keys, gas sponsorship, and policy enforcement at the wallet layer.
- **Protocol fees at the contract level.** v1.0 charges no protocol fee. A future contract upgrade may introduce a small percentage fee on settled trades (paid by one or both parties at settlement) to fund protocol operation. Any fee structure would be specified, audited, and announced in advance of activation. The current Settlement contract has no fee logic and no admin fee path.

### 11.4 Market maker sophistication

- **Adaptive MM pricing via 0G Compute** — the MM Agent is currently a deterministic spot-plus-spread daemon by design. A roadmap variant runs an LLM-aided pricing model (CEX feeds, IL hedging, dynamic spreads) inside [0G's Confidential VM](https://docs.0g.ai) for verifiable price-formation logic.
- **0G Confidential VM deployment** — running the User Agent itself inside a TEE-attested environment so users can verify the agent's behavior matches its declared policy.
- **Uniswap v4 hooks for agent-managed market-making** — once V4 hooks are stable, expose Parley MM Agents as hook-driven liquidity providers, blending the AMM and OTC models.

### 11.5 Other surfaces

- **Mainnet deployment** — the contracts and architecture are testnet-shaped today. Mainnet requires audit, real-money risk modeling, and ENS migration to mainnet `parley.eth`.
- **E-commerce / fiat gateway** — agent-to-merchant flows where Parley's negotiation layer applies to non-DeFi commerce. Out of scope architecturally; mentioned to indicate the protocol generalizes beyond token swaps.
- **Pay-with-any-token via [Uniswap's `pay-with-any-token` skill](https://github.com/Uniswap/uniswap-ai)** — the User Agent pays HTTP 402 / micropayment challenges in any token by routing through Uniswap.

---

## 12. References

### Gensyn AXL

- Concept and architecture: https://docs.gensyn.ai/tech/agent-exchange-layer
- AXL node repository: https://github.com/gensyn-ai/axl
- HTTP API: https://github.com/gensyn-ai/axl/blob/main/docs/api.md
- Reference application using AXL polling pattern: https://github.com/gensyn-ai/collaborative-autoresearch-demo

### 0G

- Builder Hub: https://build.0g.ai/
- 0G Compute (LLM inference): https://build.0g.ai/compute/
- 0G Storage (decentralized blob storage): https://build.0g.ai/storage/
- Agentic ID (ERC-7857): https://build.0g.ai/agentic-id/
- SDK index: https://build.0g.ai/sdks/
- Compute TypeScript starter kit: https://github.com/0gfoundation/0g-compute-ts-starter-kit
- Storage TypeScript starter kit: https://github.com/0gfoundation/0g-storage-ts-starter-kit
- Agentic ID examples: https://github.com/0gfoundation/agenticID-examples
- Faucet (Galileo testnet): https://faucet.0g.ai
- Compute Marketplace: https://compute-marketplace.0g.ai
- Storage Scan: https://storagescan.0g.ai
- Galileo testnet RPC: `https://evmrpc-testnet.0g.ai`
- Storage indexer: `https://indexer-storage-testnet-turbo.0g.ai`

### Uniswap

- Developer docs index: https://developers.uniswap.org/docs
- Trading API getting started: https://developers.uniswap.org/docs/trading/swapping-api/getting-started
- Supported chains: https://developers.uniswap.org/docs/trading/swapping-api/supported-chains
- API key dashboard: https://developers.uniswap.org/dashboard
- Uniswap AI overview: https://developers.uniswap.org/docs/uniswap-ai/overview
- Uniswap AI repository (skills + plugins): https://github.com/Uniswap/uniswap-ai
- Universal Router 2.0 on Sepolia: `0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b`

### ENS

- Documentation: https://docs.ens.domains/
- Building with AI: https://docs.ens.domains/building-with-ai/
- Plain-text docs for LLM context: https://docs.ens.domains/llms.txt
- Sepolia ENS Manager: https://sepolia.app.ens.domains/
- ENSIP-5 (Text Records): https://docs.ens.domains/ensip/5
- ENSIP-25 (AI Agent Registry Verification): https://docs.ens.domains/ensip/25

### Hermes Agent

- Project: Nous Research, MIT-licensed agent framework with a built-in Telegram messaging gateway and MCP host

### Adjacent standards and tools

- Model Context Protocol: https://modelcontextprotocol.io/
- Agent skills standard: https://agentskills.io/
- viem (TypeScript Ethereum client): https://viem.sh/
- wagmi (React Ethereum hooks): https://wagmi.sh/
- WalletConnect v2: https://docs.walletconnect.com/
- Foundry (Solidity toolchain): https://book.getfoundry.sh/
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Mini Apps / Web Apps: https://core.telegram.org/bots/webapps
