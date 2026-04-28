// Standalone smoke test: spawn dist/index.js as an MCP subprocess via stdio
// and exercise each registered tool. Useful for development and as a sanity
// check before wiring the server into Hermes' config.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "dist", "index.js");

// MCP SDK's StdioClientTransport spawns with a sanitized env by default;
// pass through the parent's env so the og-mcp child gets SEPOLIA_RPC_URL.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === "string") env[k] = v;
}
const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env,
});
const client = new Client({ name: "og-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:");
for (const t of tools) console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}…`);

console.log("\nresolve_mm(mm-1.parley.eth):");
const r1 = await client.callTool({
  name: "resolve_mm",
  arguments: { ens_name: "mm-1.parley.eth" },
});
console.log(JSON.stringify(r1, null, 2));

console.log("\nresolve_mm(unknown.parley.eth):");
const r2 = await client.callTool({
  name: "resolve_mm",
  arguments: { ens_name: "unknown.parley.eth" },
});
console.log(JSON.stringify(r2, null, 2));

console.log("\nread_mm_reputation(mm-1.parley.eth):");
const r3 = await client.callTool({
  name: "read_mm_reputation",
  arguments: { ens_name: "mm-1.parley.eth" },
});
console.log(JSON.stringify(r3, null, 2));

console.log("\nread_user_reputation(0xabc…):");
const r4 = await client.callTool({
  name: "read_user_reputation",
  arguments: { wallet_address: "0xabcdef1234567890abcdef1234567890abcdef12" },
});
console.log(JSON.stringify(r4, null, 2));

// Optional: full round-trip if OG_PRIVATE_KEY is set. Costs ~0.0001 OG and
// requires the SDK to talk to the Galileo storage indexer. Skipped otherwise
// so the smoke test stays cheap.
if (process.env["OG_PRIVATE_KEY"]) {
  console.log("\n=== write_trade_record (OG_PRIVATE_KEY set; doing real upload) ===");
  const fakeRecord = {
    trade_id: "0x" + "ab".repeat(32),
    timestamp: Date.now(),
    user_agent: "0xabcdef1234567890abcdef1234567890abcdef12",
    mm_agent: "0x7741114B2e5f7ff976660A00b2B548245C672B64",
    pair: "USDC/WETH",
    amount_a: "50000000",
    amount_b: "16633399867199000",
    negotiated_price: "3006.0",
    user_locked: true,
    user_locked_at: Date.now() - 1000,
    mm_locked: true,
    mm_locked_at: Date.now() - 500,
    settled: true,
    settlement_block: 12345678,
    defaulted: "none",
    user_signature: "0x" + "11".repeat(65),
    mm_signature: "0x" + "22".repeat(65),
  };
  const r = await client.callTool({
    name: "write_trade_record",
    arguments: { record: fakeRecord, mm_ens_name: "mm-1.parley.eth" },
  });
  console.log(JSON.stringify(r, null, 2));
  console.log("\n=== read_user_reputation (after one settled record) ===");
  const r2 = await client.callTool({
    name: "read_user_reputation",
    arguments: { wallet_address: fakeRecord.user_agent },
  });
  console.log(JSON.stringify(r2, null, 2));
  console.log("\n=== read_mm_reputation (after one settled record) ===");
  const r3 = await client.callTool({
    name: "read_mm_reputation",
    arguments: { ens_name: "mm-1.parley.eth" },
  });
  console.log(JSON.stringify(r3, null, 2));
} else {
  console.log("\n(write_trade_record skipped: set OG_PRIVATE_KEY to exercise the upload path)");
}

await client.close();
console.log("\n[og-mcp] smoke test ok");
