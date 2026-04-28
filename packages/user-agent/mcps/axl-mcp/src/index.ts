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
import type { Hex } from "viem";

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
const KNOWN_MM_AXL_PUBKEYS = (process.env["KNOWN_MM_AXL_PUBKEYS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const KNOWN_MM_ENS_NAMES = (process.env["KNOWN_MM_ENS_NAMES"] ?? "mm-1.parley.eth")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const axl = new AxlClient(AXL_HTTP_URL);

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
      "Return the list of MM Agents this User Agent knows about. Phase 2: hardcoded from KNOWN_MM_AXL_PUBKEYS env. Phase 3: ENS-resolved via og-mcp.resolve_mm. Pair entries match KNOWN_MM_ENS_NAMES order.",
    inputSchema: {},
  },
  async () => {
    const peers = KNOWN_MM_AXL_PUBKEYS.map((axl_pubkey, i) => ({
      ens_name: KNOWN_MM_ENS_NAMES[i] ?? null,
      axl_pubkey,
    }));
    return { content: [{ type: "text", text: JSON.stringify({ peers }, null, 2) }] };
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
    try {
      // 1 & 4a. Session sig + binding telegram_user_id consistency.
      const sessionWallet = await verifySession(
        { ...params.session_binding, wallet: params.session_binding.wallet as Hex },
        params.session_sig as Hex,
      );
      // 2. Action sig.
      const actionWallet = await verifyIntentAuthorization(
        params.intent_auth,
        params.intent_auth_sig as Hex,
        params.intent.id,
      );
      // 3. Payload schema — already validated by zod above.
      // 4b. Cross-claim binding.
      verifyBinding({
        sessionWallet,
        actionWallet,
        bindingTelegramUserId: params.session_binding.telegram_user_id,
        authTelegramUserId: params.intent_auth.telegram_user_id,
        toolCallTelegramUserId: params.telegram_user_id,
      });
      // Side effect: fan out to known peers.
      const body = JSON.stringify(params.intent);
      const sent: string[] = [];
      const errors: Array<{ peer: string; err: string }> = [];
      for (const peer of KNOWN_MM_AXL_PUBKEYS) {
        try {
          await axl.send(peer, body);
          sent.push(peer);
        } catch (e) {
          errors.push({ peer, err: (e as Error).message });
        }
      }
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
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: "TOOL_ERROR", message: (err as Error).message },
          null,
          2,
        ),
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
