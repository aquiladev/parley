// og-mcp — MCP server for 0G Storage reads/writes + ENS resolution.
// SPEC §4.3, §4.4, §7.
//
// Phase 4 status:
//   - resolve_mm:           real on-chain ENS resolution via viem.
//   - write_trade_record:   uploads a TradeRecord to 0G Storage, indexes by
//                           wallet (user) and ens_name (MM).
//   - read_trade_history:   downloads + verifies the records for a participant.
//   - read_mm_reputation:   §7.3 scoring (computeMMScore over MM records).
//   - read_user_reputation: §7.3 scoring (computeUserScore over user records).
//   - update_mm_reputation_root: writes the latest index-blob root hash to
//                                the MM's ENS text record (Phase 4B owner).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import type { TradeRecord } from "@parley/shared";

import {
  appendMMRecord,
  appendUserRecord,
  listMMRecords,
  listUserRecords,
} from "./index-store.js";
import {
  computeMMScore,
  computeUserScore,
  tallyMMStats,
  tallyUserStats,
} from "./reputation.js";
import { fetchTradeRecord, uploadTradeRecord } from "./storage.js";

const SEPOLIA_RPC_URL = process.env["SEPOLIA_RPC_URL"];
if (!SEPOLIA_RPC_URL) {
  process.stderr.write("[og-mcp] SEPOLIA_RPC_URL is required for ENS resolution\n");
  process.exit(1);
}

const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

interface MmResolution {
  ens_name: string;
  addr: Hex | null;
  axl_pubkey: string | null;
  agent_capabilities: { chain?: string; pairs?: string[]; version?: string } | string | null;
  reputation_root: string | null;
  avatar: string | null;
}

const server = new McpServer({ name: "parley-og-mcp", version: "0.1.0" });

server.registerTool(
  "resolve_mm",
  {
    description:
      "Resolve a Parley MM ENS subname (e.g., mm-1.parley.eth) on Sepolia to its EVM address, AXL public key, capabilities JSON, and reputation root. Reads via viem.getEnsAddress + getEnsText. Returns isError if the name has no resolver or the addr record is unset.",
    inputSchema: { ens_name: z.string() },
  },
  async ({ ens_name }) => {
    let name: string;
    try {
      name = normalize(ens_name);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "invalid_ens_name", ens_name, message: (err as Error).message },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    try {
      const [addr, axlPubkey, capabilitiesText, reputationRoot, avatar] = await Promise.all([
        client.getEnsAddress({ name }),
        client.getEnsText({ name, key: "axl_pubkey" }),
        client.getEnsText({ name, key: "agent_capabilities" }),
        client.getEnsText({ name, key: "reputation_root" }),
        client.getEnsText({ name, key: "avatar" }),
      ]);

      if (!addr) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "no_addr_record", ens_name },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      let capabilities: MmResolution["agent_capabilities"] = capabilitiesText;
      if (capabilitiesText) {
        try {
          capabilities = JSON.parse(capabilitiesText);
        } catch {
          // leave as raw string if it's not JSON
        }
      } else {
        capabilities = null;
      }

      const result: MmResolution = {
        ens_name,
        addr,
        axl_pubkey: axlPubkey ?? null,
        agent_capabilities: capabilities,
        reputation_root: reputationRoot ?? null,
        avatar: avatar ?? null,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "resolution_error", ens_name, message: (err as Error).message },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "read_mm_reputation",
  {
    description:
      "Return a Parley MM's aggregate reputation score in [-0.5, 1.0] alongside trade-count, keyed by ENS name. Implements SPEC §7.3 scoring (SMOOTHING=5, MM_TIMEOUT_WEIGHT=0.5) over TradeRecord blobs read from 0G Storage. Fresh accounts (zero records) get neutral 0.0.",
    inputSchema: { ens_name: z.string() },
  },
  async ({ ens_name }) => {
    const rootHashes = listMMRecords(ens_name);
    const records = await fetchAllSafely(rootHashes);
    const stats = tallyMMStats(records);
    const score = computeMMScore(stats);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ens_name,
              score,
              n_trades: records.length,
              n_settled: stats.settlements,
              n_mm_timeouts: stats.mm_timeouts,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "read_user_reputation",
  {
    description:
      "Return a user's aggregate reputation score keyed by wallet address (or ENS handle if /register opt-in is used). Implements SPEC §7.3 (SMOOTHING=5, FAILED_ACCEPT_WEIGHT=0.5). Fresh accounts get neutral 0.0.",
    inputSchema: { wallet_address: z.string() },
  },
  async ({ wallet_address }) => {
    const rootHashes = listUserRecords(wallet_address);
    const records = await fetchAllSafely(rootHashes);
    const stats = tallyUserStats(records);
    const score = computeUserScore(stats);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              wallet_address,
              score,
              n_trades: records.length,
              n_settled: stats.settlements,
              n_failed_acceptances: stats.failed_acceptances,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const TradeRecordSchema = z.object({
  trade_id: z.string(),
  timestamp: z.number(),
  user_agent: z.string(),
  mm_agent: z.string(),
  pair: z.string(),
  amount_a: z.string(),
  amount_b: z.string(),
  negotiated_price: z.string(),
  user_locked: z.boolean(),
  user_locked_at: z.number(),
  mm_locked: z.boolean(),
  mm_locked_at: z.number(),
  settled: z.boolean(),
  settlement_block: z.number().nullable(),
  defaulted: z.enum(["none", "user", "mm", "timeout"]),
  user_signature: z.string(),
  mm_signature: z.string().nullable(),
});

server.registerTool(
  "write_trade_record",
  {
    description:
      "Upload a TradeRecord blob to 0G Storage (returns the Merkle root hash) and add it to the local indices for both the user wallet and the MM ENS name. Called by both agents after every trade outcome (settled / failed / timed-out) per SPEC §7.1. Caller is responsible for providing the MM's ens_name explicitly so we can index by it (the record itself only carries wallet addresses).",
    inputSchema: {
      record: TradeRecordSchema,
      mm_ens_name: z.string(),
    },
  },
  async ({ record, mm_ens_name }) => {
    try {
      const rootHash = await uploadTradeRecord(record as TradeRecord);
      appendUserRecord(record.user_agent, rootHash);
      appendMMRecord(mm_ens_name, rootHash);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                trade_id: record.trade_id,
                root_hash: rootHash,
                indexed_for_user: record.user_agent.toLowerCase(),
                indexed_for_mm: mm_ens_name,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "upload_failed", message: (err as Error).message },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "read_trade_history",
  {
    description:
      "Return TradeRecord blobs for a participant. Pass `wallet_address` for users or `ens_name` for MMs (exactly one). Records are downloaded from 0G Storage with Merkle-proof verification.",
    inputSchema: {
      wallet_address: z.string().optional(),
      ens_name: z.string().optional(),
      limit: z.number().int().positive().max(100).default(20),
    },
  },
  async ({ wallet_address, ens_name, limit }) => {
    if ((!wallet_address && !ens_name) || (wallet_address && ens_name)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: "exactly one of wallet_address / ens_name is required" },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const hashes = wallet_address
      ? listUserRecords(wallet_address)
      : listMMRecords(ens_name!);
    const slice = hashes.slice(-limit).reverse(); // most-recent first
    const records = await fetchAllSafely(slice);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: records.length, records },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function fetchAllSafely(rootHashes: string[]): Promise<TradeRecord[]> {
  const results = await Promise.all(
    rootHashes.map(async (h) => {
      try {
        return await fetchTradeRecord(h);
      } catch (err) {
        process.stderr.write(
          `[og-mcp] failed to fetch ${h}: ${(err as Error).message}\n`,
        );
        return null;
      }
    }),
  );
  return results.filter((r): r is TradeRecord => r !== null);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is reserved for MCP protocol; log to stderr.
process.stderr.write(
  "[og-mcp] connected (resolve_mm, read_mm_reputation, read_user_reputation)\n",
);
