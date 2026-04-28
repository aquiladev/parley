// Standalone smoke test for axl-mcp.
//
// Exercises:
//   - public tools (discover_peers, get_topology, send_offer, poll_inbox)
//   - broadcast_intent happy path (signs SessionBinding + IntentAuthorization
//     with a generated EOA, expects ok=true)
//   - broadcast_intent failure paths:
//       * SESSION_INVALID    — session sig signed by a different wallet
//       * INTENT_NOT_AUTHORIZED — auth.intent_id ≠ intent.id
//       * BINDING_MISMATCH  — telegram_user_id differs across claims
//
// Requires no running AXL node for the privileged-tool checks (failures
// short-circuit before /send). The public tools that touch /topology will
// fail loudly if axl is not on USER_AXL_HTTP_URL — that's expected, the test
// catches and reports.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ACCEPT_AUTHORIZATION_EIP712_TYPES,
  INTENT_AUTHORIZATION_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  SESSION_BINDING_EIP712_TYPES,
} from "@parley/shared";
import type { Hex } from "viem";

void ACCEPT_AUTHORIZATION_EIP712_TYPES; // reserved for send_accept tests

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
});
const client = new Client({ name: "axl-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

console.log("=== tools ===");
const { tools } = await client.listTools();
for (const t of tools) console.log(`  - ${t.name}`);

console.log("\n=== public: discover_peers ===");
console.log(unwrap(await client.callTool({ name: "discover_peers", arguments: {} })));

console.log("\n=== public: get_topology (expect failure if AXL is not running) ===");
try {
  console.log(unwrap(await client.callTool({ name: "get_topology", arguments: {} })));
} catch (e) {
  console.log("(expected if AXL down):", (e as Error).message);
}

// --- Set up a synthetic user with a fresh EOA for the privileged tests ----

const userPk = generatePrivateKey();
const user = privateKeyToAccount(userPk);
const tgUserId = "12345";
const now = Math.floor(Date.now() / 1000);

const sessionBinding = {
  telegram_user_id: tgUserId,
  wallet: user.address,
  expires_at: now + 24 * 3600,
};
const sessionSig = await user.signTypedData({
  domain: PARLEY_EIP712_DOMAIN,
  types: SESSION_BINDING_EIP712_TYPES,
  primaryType: "SessionBinding",
  message: {
    telegram_user_id: BigInt(sessionBinding.telegram_user_id),
    wallet: sessionBinding.wallet,
    expires_at: BigInt(sessionBinding.expires_at),
  },
});

const intent = {
  type: "intent.broadcast" as const,
  id: "intent-smoke-001",
  agent_id: user.address,
  from_axl_pubkey: "deadbeef".repeat(8),
  timestamp: Date.now(),
  side: "sell" as const,
  base: { chain_id: 11155111, address: "0x0000000000000000000000000000000000000001" as Hex, symbol: "USDC", decimals: 6 },
  quote: { chain_id: 11155111, address: "0x0000000000000000000000000000000000000002" as Hex, symbol: "WETH", decimals: 18 },
  amount: "50",
  max_slippage_bps: 50,
  privacy: "public" as const,
  min_counterparty_rep: 0,
  timeout_ms: 60000,
  signature: "0x" as Hex,
};

const intentAuth = {
  intent_id: intent.id,
  telegram_user_id: tgUserId,
  issued_at: now,
};
const intentAuthSig = await user.signTypedData({
  domain: PARLEY_EIP712_DOMAIN,
  types: INTENT_AUTHORIZATION_EIP712_TYPES,
  primaryType: "IntentAuthorization",
  message: {
    intent_id: intentAuth.intent_id,
    telegram_user_id: BigInt(intentAuth.telegram_user_id),
    issued_at: BigInt(intentAuth.issued_at),
  },
});

console.log("\n=== privileged: broadcast_intent happy path ===");
const happy = await client.callTool({
  name: "broadcast_intent",
  arguments: {
    telegram_user_id: tgUserId,
    intent,
    intent_auth: intentAuth,
    intent_auth_sig: intentAuthSig,
    session_binding: sessionBinding,
    session_sig: sessionSig,
  },
});
console.log(unwrap(happy));
// "happy path" = validation passes; KNOWN_MM_AXL_PUBKEYS empty → no peers,
// or AXL down → errors[] populated. Either way, no UnauthorizedError.
assertNot(happy.isError, "happy broadcast must not return UnauthorizedError");

console.log("\n=== privileged: broadcast_intent → SESSION_INVALID (sig from wrong wallet) ===");
const otherUser = privateKeyToAccount(generatePrivateKey());
const wrongSessionSig = await otherUser.signTypedData({
  domain: PARLEY_EIP712_DOMAIN,
  types: SESSION_BINDING_EIP712_TYPES,
  primaryType: "SessionBinding",
  message: {
    telegram_user_id: BigInt(sessionBinding.telegram_user_id),
    wallet: sessionBinding.wallet, // claims to be `user`
    expires_at: BigInt(sessionBinding.expires_at),
  },
});
const r2 = await client.callTool({
  name: "broadcast_intent",
  arguments: {
    telegram_user_id: tgUserId,
    intent,
    intent_auth: intentAuth,
    intent_auth_sig: intentAuthSig,
    session_binding: sessionBinding,
    session_sig: wrongSessionSig,
  },
});
console.log(unwrap(r2));
assertReason(r2, "SESSION_INVALID");

console.log("\n=== privileged: broadcast_intent → INTENT_NOT_AUTHORIZED (auth.intent_id ≠ intent.id) ===");
const r3 = await client.callTool({
  name: "broadcast_intent",
  arguments: {
    telegram_user_id: tgUserId,
    intent: { ...intent, id: "different-id-than-auth" },
    intent_auth: intentAuth,
    intent_auth_sig: intentAuthSig,
    session_binding: sessionBinding,
    session_sig: sessionSig,
  },
});
console.log(unwrap(r3));
assertReason(r3, "INTENT_NOT_AUTHORIZED");

console.log("\n=== privileged: broadcast_intent → BINDING_MISMATCH (mismatched telegram_user_id) ===");
const r4 = await client.callTool({
  name: "broadcast_intent",
  arguments: {
    telegram_user_id: "67890", // different from binding/auth
    intent,
    intent_auth: intentAuth,
    intent_auth_sig: intentAuthSig,
    session_binding: sessionBinding,
    session_sig: sessionSig,
  },
});
console.log(unwrap(r4));
assertReason(r4, "BINDING_MISMATCH");

await client.close();
console.log("\n[axl-mcp] smoke test ok");

// ---- helpers --------------------------------------------------------------

function unwrap(res: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  const parts = res.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return (res.isError ? "[isError] " : "") + parts.join("\n");
}

function assertNot(cond: unknown, msg: string): void {
  if (cond) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

function assertReason(
  res: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  expected: string,
): void {
  if (!res.isError) throw new Error(`expected isError=true for reason ${expected}`);
  const text = unwrap(res);
  if (!text.includes(expected)) {
    throw new Error(`expected reason ${expected}, got: ${text}`);
  }
}
