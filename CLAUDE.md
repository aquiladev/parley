# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repo is **spec-only** at present. The single source of truth is `SPEC.md` (Parley v1.2 — "the agent layer for peer DeFi"). No source code, no build config, no `package.json`, no Foundry project exists yet. When you're asked to implement something, treat `SPEC.md` as the canonical reference and grep it for the relevant section before writing code — it is detailed enough that most "how should this work?" questions are already answered there.

The intended layout (Section 3 of the spec) is a pnpm workspace monorepo with five packages:

- `packages/user-agent/` — Hermes Agent (Nous Research) + custom MCP servers (`axl-mcp`, `og-mcp`) + AXL sidecar. The user-side runtime.
- `packages/mm-agent/` — Plain Node.js + TypeScript daemon. **No LLM, no framework** — pricing is deterministic spot+spread.
- `packages/contracts/` — Foundry project. Single `Settlement.sol` contract.
- `packages/miniapp/` — Next.js 14 App Router + wagmi + WalletConnect v2. The signing/submission surface inside Telegram.
- `packages/shared/` — Shared TS types (`Intent`, `Offer`, `Deal`, `TradeRecord`).

Target chain is **Sepolia only**. Node 24+ (LTS Krypton; pinned via `.nvmrc` to `lts/krypton` — run `nvm use` in this repo), pnpm 10+, Go 1.25.5+ (build-only, for the AXL sidecar binary), Solidity 0.8.x, Foundry.

## Architecture: the load-bearing invariants

Most of the codebase will follow obvious patterns once it exists, but several cross-cutting decisions in the spec are non-obvious and easy to violate accidentally. Read these before changing anything in those areas.

### Asymmetric submission model (Section 8)

**The User Agent never submits transactions and holds no spendable funds.** It is a calldata builder, not a wallet. Every user-side state-changing call (`lockUserSide`, `settle`, `refund`, Uniswap fallback swap, optional ENS registration) is submitted from the user's own wallet via the Mini App using `wagmi.writeContract` / `wagmi.sendTransaction`.

The MM Agent is the opposite: it submits `lockMMSide` (and by courtesy sometimes `settle`/`refund`) directly from a funded hot wallet via `viem`.

If you find yourself reaching for `walletClient.writeContract` inside `packages/user-agent/`, you are probably violating this invariant. The user-side helper at `packages/user-agent/lib/settlement.ts` returns `PreparedLockUserSide`-style structs (typedData + callTarget + argsWithoutSig) for the Mini App to consume — see Section 8.2.

### Two identity models, deliberately asymmetric (Section 4.0)

- **MM Agents** are identified by an ENS subname under `parley.eth` (e.g., `mm-1.parley.eth`). The subname carries `addr`, `text("axl_pubkey")`, `text("agent_capabilities")`, `text("reputation_root")`, optional `text("avatar")`. The ENS name is the **canonical** handle — wallet and AXL pubkey are derived via resolution.
- **Users** are identified by **wallet address only**. There is no on-chain user registry. ENS subnames for users are strictly opt-in via `/register <handle>` (Section 4.5.3) and unlock display name + cross-wallet reputation portability — they are **not** an authorization gate.

When verifying an incoming MM offer, you must cross-reference: AXL `X-From-Peer-Id` matches the resolved `axl_pubkey` text record AND the EIP-712 deal-terms signature recovers to the resolved `addr`. Don't trust message-claimed identity (Section 4.4).

### Privileged MCP tools enforce server-side validation (Section 4.3)

Tools marked **privileged** in `axl-mcp` and `og-mcp` (`broadcast_intent`, `send_accept`, `write_trade_record`) MUST run all four validation checks on every invocation, throwing `UnauthorizedError` with one of: `SESSION_INVALID`, `INTENT_NOT_AUTHORIZED`, `MALFORMED_PAYLOAD`, `BINDING_MISMATCH`. The SOUL.md tells Hermes how to call them, but the tools do not trust the caller. There is intentionally **no** ENS-ownership check among these — that was dropped in spec v1.2.

### AXL is poll-only (Section 4.1, 5.0)

AXL has no push primitive. The User Agent uses Hermes scheduled automation to call `axl-mcp.poll_inbox()` every ~2s during active negotiation; under the hood it loops `GET /recv` until 204. There is no broadcast endpoint either — `axl-mcp.broadcast_intent` fans out `POST /send` to each peer resolved via ENS (`KNOWN_MM_ENS_NAMES` env). When implementing async flows, do not assume push.

The AXL node is a **separate Go binary** (`gensyn-ai/axl`) running as a sidecar on `localhost:9002`. Our agents speak HTTP to it; they do not import it as a library. The chain-watcher subroutine for `UserLocked`/`MMLocked`/`Settled`/`Refunded` lives in the same sidecar and injects events into Hermes' inbox the same way AXL events do.

### MM Agent stays deterministic (Section 4.2)

Do **not** add an LLM to the MM pricing path. Pricing is `uniswap_twap * (1 + spread_bps / 10000)`. Inventory is static config, no rebalancing. This is a design constraint, not an oversight — Section 4.2 explicitly justifies it ("auditable, fast, and deterministic"). LLM-aided MM pricing is roadmap §11.4, not v1.0.

### Reputation is computed, not stored (Section 7.3)

Scores are derived on demand from `TradeRecord` blobs in 0G Storage by `og-mcp.read_user_reputation` / `read_mm_reputation`. User reputation is keyed by wallet address (or ENS if opted-in); MM reputation is always keyed by ENS. The two scoring functions differ — `computeUserScore` penalizes failed acceptances; `computeMMScore` penalizes lock timeouts. Smoothing constant is 5; on-chain reverts are deliberately **not** counted (signal is too ambiguous).

## Commands

No build/test infrastructure exists yet. Once `pnpm-workspace.yaml`, `package.json`, and `packages/contracts/foundry.toml` land, the expected commands per the spec are:

- TypeScript packages: pnpm workspaces (`pnpm install`, `pnpm -r build`, `pnpm -F <pkg> test`).
- Contracts: Foundry (`forge build`, `forge test`, `forge script script/Deploy.s.sol`).
- AXL sidecar: built locally from `gensyn-ai/axl` with `make build`; runs on `localhost:9002`.

Verify the actual scripts in `package.json` once present rather than assuming.

## Key environment variables (per spec)

- `KNOWN_MM_ENS_NAMES` — comma-separated MM ENS subnames the User Agent discovers (e.g., `mm-1.parley.eth,mm-2.parley.eth`).
- `AXL_PRIVATE_KEY_PATH` — ed25519 PEM, generated with `openssl genpkey -algorithm ed25519`. Both agent types need one.
- `MM_EVM_PRIVATE_KEY` — MM Agent's hot wallet (Sepolia-funded). MM Agents only.
- `ZG_COMPUTE_ENDPOINT`, `ZG_COMPUTE_KEY` — 0G Compute (OpenAI-compatible LLM endpoint for the User Agent's Hermes config).
- `OG_PRIVATE_KEY` — separate key for paying 0G Storage uploads (OG tokens, not Sepolia gas).
- `TELEGRAM_BOT_TOKEN`, `UNISWAP_API_KEY`.

## When in doubt

The spec is unusually thorough — section numbers in this file point at the relevant detail. If you can't find an answer there, ask the user before guessing; they wrote it deliberately and will have an opinion. Avoid introducing new abstractions, helpers, or "future-proofing" not motivated by something in `SPEC.md` — Section 11 already enumerates what is intentionally deferred.
