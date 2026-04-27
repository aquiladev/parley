// Phase 0 smoke test: end-to-end inference call against 0G Compute Network.
//
// The 0G Compute auth model is NOT a static API key. Each request needs
// per-call signed headers from the broker SDK; the OpenAI client gets an
// empty apiKey and uses those headers to prove payment authorization.
// Post-call, processResponse() settles on-chain.
//
// Prereqs (Phase 0 #4 in ROADMAP.md):
//   1. Galileo testnet wallet, funded via faucet.0g.ai
//   2. Ledger created + provider acknowledged via 0g-compute-cli
//      (deposit, transfer-fund, acknowledge-provider).
//   3. .env populated:
//        OG_PRIVATE_KEY        — the wallet PK that owns the ledger
//        ZG_COMPUTE_PROVIDER   — provider address acknowledged in step 2
//        ZG_RPC_URL (optional) — defaults to https://evmrpc-testnet.0g.ai
//
// Run:
//   pnpm -F @parley/user-agent phase0:zg-compute

import OpenAI from "openai";
import { ethers } from "ethers";
import { createRequire } from "node:module";

// Load the broker via CJS — its ESM build (v0.6.6) is broken: the .mjs stub
// re-exports from a .js file that's actually ESM but lacks "type": "module",
// so Node parses it as CJS and the named exports vanish. CJS bundle works.
const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } = require(
  "@0glabs/0g-serving-broker",
) as typeof import("@0glabs/0g-serving-broker");

const PRIVATE_KEY = process.env["OG_PRIVATE_KEY"];
const RPC_URL = process.env["ZG_RPC_URL"] ?? "https://evmrpc-testnet.0g.ai";
const CONFIGURED_PROVIDER = process.env["ZG_COMPUTE_PROVIDER"];

if (!PRIVATE_KEY) {
  console.error("OG_PRIVATE_KEY is unset. Put your Galileo testnet wallet PK in .env.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const broker = await createZGComputeNetworkBroker(wallet);

let providerAddr = CONFIGURED_PROVIDER;
if (!providerAddr) {
  const services = await broker.inference.listService();
  if (services.length === 0) {
    console.error("No 0G Compute services available. Check the marketplace.");
    process.exit(1);
  }
  providerAddr = services[0].provider;
  console.log(
    `[zg-compute] ZG_COMPUTE_PROVIDER unset; defaulting to first available: ${providerAddr}`,
  );
  console.log(
    "  (set ZG_COMPUTE_PROVIDER in .env to the address you acknowledged via 0g-compute-cli)",
  );
}

const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddr);
console.log(`[zg-compute] provider=${providerAddr}`);
console.log(`[zg-compute] endpoint=${endpoint}`);
console.log(`[zg-compute] model=${model}`);

const query = "Reply with exactly: HELLO_FROM_0G";

const rawHeaders = await broker.inference.getRequestHeaders(providerAddr, query);
const headers: Record<string, string> = {};
for (const [k, v] of Object.entries(rawHeaders)) {
  if (typeof v === "string") headers[k] = v;
}

const client = new OpenAI({ baseURL: endpoint, apiKey: "" });

const started = Date.now();
const completion = await client.chat.completions.create(
  { messages: [{ role: "user", content: query }], model },
  { headers },
);
const elapsed = Date.now() - started;
const text = completion.choices[0]?.message?.content ?? "<empty>";
console.log(`[zg-compute] ${elapsed}ms ← ${text.trim()}`);

if (completion.id) {
  try {
    await broker.inference.processResponse(providerAddr, completion.id, text);
    console.log(`[zg-compute] response settled on-chain (chatId=${completion.id})`);
  } catch (err) {
    // TEE attestation / signature verification can fail in testnet — inference
    // already worked, so don't block the Phase 0 acceptance check on it.
    console.warn(
      `[zg-compute] processResponse failed (non-fatal): ${(err as Error).message}`,
    );
  }
}
