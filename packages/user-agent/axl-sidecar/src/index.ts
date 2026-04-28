// AXL listener sidecar. SPEC §4.1.
//
// Two concurrent loops:
//   1. AXL /recv polling — drains the queue every 2s, emits structured JSON logs.
//   2. Chain watcher — viem.watchContractEvent on Settlement events
//      (UserLocked, MMLocked, Settled, Refunded), emits the same log shape.
//
// Phase 2 scope: observability only. Hermes' scheduled automation calls
// axl-mcp.poll_inbox() to bridge AXL messages into the agent loop, and
// Hermes' own scheduled tool calls can inspect on-chain state via viem
// reads. The sidecar provides operator-grade visibility into both streams.
//
// Strategy B (direct push into Hermes' inbox) is deferred to Phase 4 — it
// requires a Hermes inbox-injection API that needs verification first.

import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { AxlClient } from "../../lib/axl-client.js";

const AXL_HTTP_URL = process.env["USER_AXL_HTTP_URL"] ?? "http://localhost:9002";
const SEPOLIA_RPC_URL = process.env["SEPOLIA_RPC_URL"];
const SETTLEMENT_CONTRACT = process.env["SETTLEMENT_CONTRACT_ADDRESS"] as Hex | undefined;
const POLL_INTERVAL_MS = 2_000;

const SETTLEMENT_ABI = parseAbi([
  "event UserLocked(bytes32 indexed dealHash, address indexed user)",
  "event MMLocked(bytes32 indexed dealHash, address indexed mm)",
  "event Settled(bytes32 indexed dealHash)",
  "event Refunded(bytes32 indexed dealHash, address indexed party)",
]);

function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]),
    );
  }
  return v;
}

function log(obj: Record<string, unknown>): void {
  const payload = jsonSafe({ ts: new Date().toISOString(), ...obj });
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function pollAxlForever(axl: AxlClient): Promise<void> {
  while (true) {
    try {
      const msg = await axl.recv();
      if (msg) {
        const text = msg.body.toString("utf-8");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        log({ event: "axl_recv", from_peer_id: msg.fromPeerId, body });
      }
    } catch (err) {
      log({ event: "axl_recv_error", err: (err as Error).message });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

const CHAIN_POLL_INTERVAL_MS = 5_000;

async function watchChainPolling(): Promise<void> {
  if (!SEPOLIA_RPC_URL) {
    log({ event: "chain_watch_skipped", reason: "SEPOLIA_RPC_URL not set" });
    return;
  }
  if (!SETTLEMENT_CONTRACT) {
    log({ event: "chain_watch_skipped", reason: "SETTLEMENT_CONTRACT_ADDRESS not set" });
    return;
  }
  // getContractEvents-based poll loop instead of viem's filter-based
  // watchContractEvent. Free public Sepolia RPCs (publicnode.com etc.)
  // routinely drop eth_newFilter handles between polls, surfacing as
  // "filter not found" — see Phase 0 risk register. eth_getLogs over a
  // bounded block range is robust on the same RPCs.
  const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
  let lastSeen = await client.getBlockNumber();
  log({ event: "chain_watch_started", contract: SETTLEMENT_CONTRACT, from_block: lastSeen });

  while (true) {
    try {
      const current = await client.getBlockNumber();
      if (current > lastSeen) {
        const logs = await client.getContractEvents({
          address: SETTLEMENT_CONTRACT,
          abi: SETTLEMENT_ABI,
          fromBlock: lastSeen + 1n,
          toBlock: current,
        });
        for (const l of logs) {
          log({
            event: "chain_event",
            event_name: l.eventName,
            args: l.args as Record<string, unknown>,
            block: l.blockNumber,
            tx: l.transactionHash,
          });
        }
        lastSeen = current;
      }
    } catch (err) {
      log({ event: "chain_watch_error", err: (err as Error).message });
    }
    await sleep(CHAIN_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const axl = new AxlClient(AXL_HTTP_URL);
  let topo;
  try {
    topo = await axl.topology();
  } catch (err) {
    log({
      event: "boot_error",
      reason: "axl topology unreachable",
      err: (err as Error).message,
      axl_url: AXL_HTTP_URL,
    });
    process.exit(1);
  }
  log({
    event: "boot",
    axl_url: AXL_HTTP_URL,
    axl_pubkey: topo.ourPublicKey,
    axl_peers: topo.peers.length,
    settlement: SETTLEMENT_CONTRACT,
    rpc_url_set: !!SEPOLIA_RPC_URL,
  });

  void watchChainPolling();
  void pollAxlForever(axl);
}

main().catch((err) => {
  process.stderr.write(`[axl-sidecar] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
