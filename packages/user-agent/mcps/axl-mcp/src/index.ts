// axl-mcp — MCP server exposing AXL peer-network tools to Hermes.
// SPEC §4.3, §5.0.
//
// Tools:
//   - discover_peers()                                   (public)
//   - get_topology()                                     (public)
//   - poll_inbox()                                       (public, drains /recv)
//   - send_offer(to_peer_id, offer)                      (public, generic outbound)
//   - broadcast_intent(...)                              [PRIVILEGED]
//   - send_accept(...)                                   [PRIVILEGED]
//
// Privileged tools run all four §4.3 validation checks before any side effect:
//   1. session signature
//   2. action signature
//   3. payload schema
//   4. telegram_user_id ↔ wallet binding consistency
//
// Failure throws UnauthorizedError with one of SESSION_INVALID,
// INTENT_NOT_AUTHORIZED, MALFORMED_PAYLOAD, or BINDING_MISMATCH.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

import { AxlClient } from "./axl-client.js";
import {
  UnauthorizedError,
  verifyAcceptAuthorization,
  verifyBinding,
  verifyIntentAuthorization,
  verifySession,
} from "./verify.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AXL_HTTP_URL = process.env["USER_AXL_HTTP_URL"] ?? "http://localhost:9002";
const KNOWN_MM_ENS_NAMES = (process.env["KNOWN_MM_ENS_NAMES"] ?? "mm-1.parley.eth")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SEPOLIA_RPC_URL = process.env["SEPOLIA_RPC_URL"];

const axl = new AxlClient(AXL_HTTP_URL);
// Lazy: only create the chain client when ENS resolution is actually needed.
// axl-mcp can otherwise run without a Sepolia RPC (poll_inbox, get_topology,
// the privileged tools' validation logic — none touch the chain).
let cachedChainClient: ReturnType<typeof createPublicClient> | null = null;
function chainClient() {
  if (cachedChainClient) return cachedChainClient;
  if (!SEPOLIA_RPC_URL) {
    throw new Error("SEPOLIA_RPC_URL is required for ENS resolution");
  }
  cachedChainClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  return cachedChainClient;
}

interface ResolvedPeer {
  ens_name: string;
  addr?: Hex;
  axl_pubkey?: string;
  error?: string;
}

async function resolveAllPeers(): Promise<ResolvedPeer[]> {
  const client = chainClient();
  return Promise.all(
    KNOWN_MM_ENS_NAMES.map(async (rawName): Promise<ResolvedPeer> => {
      let name: string;
      try {
        name = normalize(rawName);
      } catch (err) {
        return { ens_name: rawName, error: `invalid_ens_name: ${(err as Error).message}` };
      }
      try {
        const [addr, axlPubkey] = await Promise.all([
          client.getEnsAddress({ name }),
          client.getEnsText({ name, key: "axl_pubkey" }),
        ]);
        if (!addr) return { ens_name: rawName, error: "no_addr_record" };
        if (!axlPubkey) {
          return { ens_name: rawName, addr, error: "no_axl_pubkey_text_record" };
        }
        return { ens_name: rawName, addr, axl_pubkey: axlPubkey };
      } catch (err) {
        return { ens_name: rawName, error: `resolution_error: ${(err as Error).message}` };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Shared zod fragments
// ---------------------------------------------------------------------------

const HexString = z.string().regex(/^0x[0-9a-fA-F]+$/);
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const SessionBindingSchema = z.object({
  telegram_user_id: z.string(),
  wallet: Address,
  expires_at: z.number().int().positive(),
});

const IntentAuthSchema = z.object({
  intent_id: z.string().min(1),
  telegram_user_id: z.string(),
  issued_at: z.number().int().positive(),
});

const AcceptAuthSchema = z.object({
  offer_id: z.string().min(1),
  deal_hash: Bytes32,
  telegram_user_id: z.string(),
  issued_at: z.number().int().positive(),
});

// Loose Intent/Accept schemas — full schema validation is the responsibility
// of the recipient, not us. We just check the shape Hermes hands in.
const IntentSchema = z
  .object({
    type: z.literal("intent.broadcast"),
    id: z.string().min(1),
    agent_id: Address,
    from_axl_pubkey: z.string(),
  })
  .passthrough();

const AcceptSchema = z
  .object({
    type: z.literal("offer.accept"),
    id: z.string().min(1),
    offer_id: z.string().min(1),
    user_agent_id: Address,
    deal_hash: Bytes32,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "parley-axl-mcp", version: "0.1.0" });

// ---- public tools ---------------------------------------------------------

server.registerTool(
  "discover_peers",
  {
    description:
      "Return the list of MM Agents this User Agent knows about, resolved live from Sepolia ENS. Reads KNOWN_MM_ENS_NAMES env, resolves each in parallel via viem.getEnsAddress + getEnsText('axl_pubkey'), returns {ens_name, addr, axl_pubkey} per peer. Names that fail to resolve (no addr or no axl_pubkey record) are surfaced with an `error` field rather than dropped silently.",
    inputSchema: {},
  },
  async () => {
    try {
      const peers = await resolveAllPeers();
      return { content: [{ type: "text", text: JSON.stringify({ peers }, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: (err as Error).message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_topology",
  {
    description:
      "Return this AXL node's identity and current peer state from /topology.",
    inputSchema: {},
  },
  async () => {
    const t = await axl.topology();
    return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }] };
  },
);

server.registerTool(
  "poll_inbox",
  {
    description:
      "Drain the local AXL node's /recv queue. Returns an array of {fromPeerId, body_text} entries (body_text is the JSON-decoded message body, falling back to raw text if not JSON). Empty array means the queue was empty at call time.",
    inputSchema: { max_messages: z.number().int().positive().max(64).default(16) },
  },
  async ({ max_messages }) => {
    const out: Array<{ fromPeerId: string; body: unknown }> = [];
    for (let i = 0; i < max_messages; i++) {
      const msg = await axl.recv();
      if (!msg) break;
      const text = msg.body.toString("utf-8");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      out.push({ fromPeerId: msg.fromPeerId, body });
    }
    return { content: [{ type: "text", text: JSON.stringify({ messages: out }, null, 2) }] };
  },
);

server.registerTool(
  "send_offer",
  {
    description:
      "Generic outbound AXL message — sends a JSON-serializable payload to a destination peer. Listed in SPEC §4.3 axl-mcp tool surface for symmetry with the MM side. The User Agent rarely uses this directly; broadcast_intent and send_accept are the user-side privileged paths.",
    inputSchema: {
      to_peer_id: z.string().min(1),
      payload: z.unknown(),
    },
  },
  async ({ to_peer_id, payload }) => {
    await axl.send(to_peer_id, JSON.stringify(payload));
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, to: to_peer_id }, null, 2) }] };
  },
);

// ---- intent builder -------------------------------------------------------

// Sepolia token registry the agent can refer to by symbol. The MM Agent
// quotes the same pair, so keeping this table in sync with the MM side is
// load-bearing — bake into env if it grows.
const SEPOLIA_USDC = (process.env["SEPOLIA_USDC_ADDRESS"] ??
  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Hex;
const SEPOLIA_WETH = (process.env["SEPOLIA_WETH_ADDRESS"] ??
  "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14") as Hex;

interface TokenSpec {
  chain_id: number;
  address: Hex;
  symbol: string;
  decimals: number;
}

const TOKEN_BY_SYMBOL: Record<string, TokenSpec> = {
  USDC: { chain_id: 11155111, address: SEPOLIA_USDC, symbol: "USDC", decimals: 6 },
  WETH: { chain_id: 11155111, address: SEPOLIA_WETH, symbol: "WETH", decimals: 18 },
  // "ETH" is shorthand for WETH in this demo — Settlement.sol moves ERC-20s,
  // not native ETH. The user means WETH; resolve transparently.
  ETH:  { chain_id: 11155111, address: SEPOLIA_WETH, symbol: "WETH", decimals: 18 },
};

/** Phase 10: resolve a TokenRef from either explicit (address, decimals)
 *  fields OR fall back to the legacy symbol-only lookup table. Both
 *  modes return the same `TokenSpec` shape so the rest of build_intent
 *  doesn't need to know which path was taken. */
function resolveTokenRef(
  symbol: string,
  address?: string,
  decimals?: number,
): { ok: true; value: TokenSpec } | { ok: false; error: string } {
  if (address !== undefined) {
    if (decimals === undefined) {
      return {
        ok: false,
        error: `${symbol}: when an explicit address is provided, decimals is required (call mcp_parley_og_validate_token first to read decimals from the contract).`,
      };
    }
    return {
      ok: true,
      value: {
        chain_id: 11155111,
        address: address.toLowerCase() as Hex,
        symbol,
        decimals,
      },
    };
  }
  const legacy = TOKEN_BY_SYMBOL[symbol.toUpperCase()];
  if (!legacy) {
    return {
      ok: false,
      error: `unknown token symbol "${symbol}". Either pass an explicit address+decimals (Phase 10 multi-token), or use one of the canonical symbols: ${Object.keys(TOKEN_BY_SYMBOL).join(", ")}.`,
    };
  }
  return { ok: true, value: legacy };
}

function errorResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: code, message }, null, 2),
      },
    ],
    isError: true,
  };
}

function uuidv4(): string {
  // Avoid pulling in a uuid dep for one call. RFC4122 v4 manual implementation.
  const bytes = new Uint8Array(16);
  // crypto.getRandomValues is in node 20+ globalThis.crypto.
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  const b = Array.from(bytes, h);
  return [
    b.slice(0, 4).join(""),
    b.slice(4, 6).join(""),
    b.slice(6, 8).join(""),
    b.slice(8, 10).join(""),
    b.slice(10, 16).join(""),
  ].join("-");
}

server.registerTool(
  "build_intent",
  {
    description:
      "Construct a complete `Intent` envelope from user-facing inputs. Two modes:\n" +
      "(1) **Canonical-symbol mode** (Phase 1+): pass `base_symbol` + `quote_symbol` only. Resolves to canonical Sepolia USDC/WETH addresses (`ETH` is treated as a WETH alias).\n" +
      "(2) **Multi-token mode** (Phase 10): pass `base_symbol` + `base_address` + `base_decimals` (and same for `quote_*`) when the user provided explicit addresses (`swap N FOO(0xaddr) for BAR(0xaddr)` syntax). Use `mcp_parley_og_validate_token` first to read `decimals` and confirm `symbol` from the contract — then pass them in here so the Intent's TokenRefs are correct.\n" +
      "Mints a fresh `id` (UUID v4), reads `from_axl_pubkey` from this AXL node's /topology, sets `timestamp`/`privacy`/`signature` defaults, and stamps `agent_id` from `user_wallet`. Returns { ok:true, intent } on success. **Always call this before /authorize-intent and broadcast_intent — never hand-build the Intent JSON.**",
    inputSchema: {
      side: z.enum(["buy", "sell"]),
      base_symbol: z.string().min(1),
      quote_symbol: z.string().min(1),
      // Phase 10: optional explicit address + decimals. When base_address
      // is provided, base_decimals is required. Same for quote.
      base_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      base_decimals: z.number().int().min(0).max(30).optional(),
      quote_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      quote_decimals: z.number().int().min(0).max(30).optional(),
      amount: z.string().min(1),
      max_slippage_bps: z.number().int().min(0).max(500).default(50),
      timeout_ms: z.number().int().min(10_000).max(600_000).default(60_000),
      min_counterparty_rep: z.number().min(-0.5).max(1).default(0),
      user_wallet: Address,
    },
  },
  async ({
    side,
    base_symbol,
    quote_symbol,
    base_address,
    base_decimals,
    quote_address,
    quote_decimals,
    amount,
    max_slippage_bps,
    timeout_ms,
    min_counterparty_rep,
    user_wallet,
  }) => {
    // Resolve `base` and `quote` TokenRefs. If an explicit address was
    // provided for either side, Phase 10 multi-token path: build the
    // TokenRef from (symbol, address, decimals). Otherwise fall through
    // to the canonical-symbol lookup.
    const base = resolveTokenRef(base_symbol, base_address, base_decimals);
    if (!base.ok) {
      return errorResult("UNKNOWN_TOKEN", `base: ${base.error}`);
    }
    const quote = resolveTokenRef(quote_symbol, quote_address, quote_decimals);
    if (!quote.ok) {
      return errorResult("UNKNOWN_TOKEN", `quote: ${quote.error}`);
    }

    let fromAxlPubkey: string;
    try {
      const t = await axl.topology();
      fromAxlPubkey = t.ourPublicKey;
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: "AXL_TOPOLOGY_UNREACHABLE",
                message: (err as Error).message,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const intent = {
      type: "intent.broadcast" as const,
      id: uuidv4(),
      agent_id: user_wallet,
      from_axl_pubkey: fromAxlPubkey,
      timestamp: Math.floor(Date.now() / 1000),
      side,
      base: base.value,
      quote: quote.value,
      amount,
      max_slippage_bps,
      privacy: "public" as const,
      min_counterparty_rep,
      timeout_ms,
      // Intent.signature is the user-side outer wrapping sig (SPEC §5.1) —
      // distinct from the IntentAuthorization sig the agent collects via
      // /authorize-intent. v1.0 leaves it as a placeholder; the §4.3
      // privileged-tool checks supersede it for our peer-mesh use.
      signature: "0x" as Hex,
    };

    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, intent }, null, 2) },
      ],
    };
  },
);

// ---- privileged tools -----------------------------------------------------

server.registerTool(
  "broadcast_intent",
  {
    description:
      "PRIVILEGED. Broadcast an Intent to all known MM peers. Validates session signature, intent authorization signature, payload schema, and telegram_user_id ↔ wallet binding (SPEC §4.3) before fanning out to peers. Throws UnauthorizedError with reason code on any check failure.",
    inputSchema: {
      telegram_user_id: z.string(),
      intent: IntentSchema,
      intent_auth: IntentAuthSchema,
      intent_auth_sig: HexString,
      session_binding: SessionBindingSchema,
      session_sig: HexString,
    },
  },
  async (params) => {
    const t0 = Date.now();
    const log = (event: string, extra: Record<string, unknown> = {}) => {
      process.stderr.write(
        `[axl-mcp] broadcast_intent ${event} +${Date.now() - t0}ms ${JSON.stringify(extra)}\n`,
      );
    };
    try {
      log("start", { intent_id: params.intent.id });
      // 1 & 4a. Session sig + binding telegram_user_id consistency.
      const sessionWallet = await verifySession(
        { ...params.session_binding, wallet: params.session_binding.wallet as Hex },
        params.session_sig as Hex,
      );
      log("session_verified", { wallet: sessionWallet });
      // 2. Action sig.
      const actionWallet = await verifyIntentAuthorization(
        params.intent_auth,
        params.intent_auth_sig as Hex,
        params.intent.id,
      );
      log("auth_verified");
      // 3. Payload schema — already validated by zod above.
      // 4b. Cross-claim binding.
      verifyBinding({
        sessionWallet,
        actionWallet,
        bindingTelegramUserId: params.session_binding.telegram_user_id,
        authTelegramUserId: params.intent_auth.telegram_user_id,
        toolCallTelegramUserId: params.telegram_user_id,
      });
      log("binding_verified");
      // Side effect: resolve peers via ENS and fan out.
      const body = JSON.stringify(params.intent);
      const sent: Array<{ ens_name: string; axl_pubkey: string }> = [];
      const errors: Array<{ peer: string; err: string }> = [];
      const resolved = await resolveAllPeers();
      log("peers_resolved", {
        n: resolved.length,
        ok: resolved.filter((p) => !p.error).length,
      });
      for (const peer of resolved) {
        if (peer.error || !peer.axl_pubkey) {
          errors.push({ peer: peer.ens_name, err: peer.error ?? "no_axl_pubkey" });
          continue;
        }
        try {
          await axl.send(peer.axl_pubkey, body);
          log("sent_to_peer", { ens: peer.ens_name });
          sent.push({ ens_name: peer.ens_name, axl_pubkey: peer.axl_pubkey });
        } catch (e) {
          log("send_error", { ens: peer.ens_name, err: (e as Error).message });
          errors.push({ peer: peer.ens_name, err: (e as Error).message });
        }
      }
      log("done", { sent: sent.length, errors: errors.length });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                intent_id: params.intent.id,
                broadcast_to: sent,
                errors,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return rejectAsAuthFailure(err);
    }
  },
);

server.registerTool(
  "send_accept",
  {
    description:
      "PRIVILEGED. Send an Accept message to the MM that produced the offer. Same four §4.3 validation checks as broadcast_intent. The accept's deal_hash must match the value in accept_auth (catches a malicious caller substituting a different deal).",
    inputSchema: {
      telegram_user_id: z.string(),
      to_peer_id: z.string().min(1),
      accept: AcceptSchema,
      accept_auth: AcceptAuthSchema,
      accept_auth_sig: HexString,
      session_binding: SessionBindingSchema,
      session_sig: HexString,
    },
  },
  async (params) => {
    try {
      const sessionWallet = await verifySession(
        { ...params.session_binding, wallet: params.session_binding.wallet as Hex },
        params.session_sig as Hex,
      );
      const actionWallet = await verifyAcceptAuthorization(
        { ...params.accept_auth, deal_hash: params.accept_auth.deal_hash as Hex },
        params.accept_auth_sig as Hex,
        params.accept.offer_id,
        params.accept.deal_hash as Hex,
      );
      verifyBinding({
        sessionWallet,
        actionWallet,
        bindingTelegramUserId: params.session_binding.telegram_user_id,
        authTelegramUserId: params.accept_auth.telegram_user_id,
        toolCallTelegramUserId: params.telegram_user_id,
      });
      await axl.send(params.to_peer_id, JSON.stringify(params.accept));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, offer_id: params.accept.offer_id, sent_to: params.to_peer_id },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return rejectAsAuthFailure(err);
    }
  },
);

// ---------------------------------------------------------------------------

function rejectAsAuthFailure(err: unknown) {
  if (err instanceof UnauthorizedError) {
    // Hermes' agent.log truncates the tool body to one line ("failed: ");
    // mirror to stderr so the real reason lands in mcp-stderr.log.
    process.stderr.write(
      `[axl-mcp] privileged tool rejected: ${err.reason} — ${err.message}\n`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err.reason, message: err.message }, null, 2),
        },
      ],
      isError: true,
    };
  }
  // Non-auth error (network, AXL down, etc.) — surface as a tool-side error.
  const msg = (err as Error).message ?? String(err);
  process.stderr.write(`[axl-mcp] tool error: ${msg}\n`);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: "TOOL_ERROR", message: msg }, null, 2),
      },
    ],
    isError: true,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  "[axl-mcp] connected (discover_peers, get_topology, poll_inbox, send_offer, broadcast_intent*, send_accept*) — * = privileged\n",
);
