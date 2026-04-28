// og-mcp — MCP server for 0G Storage reads/writes + ENS resolution.
// SPEC §4.3, §4.4, §7.
//
// Phase 3 status:
//   - resolve_mm:           real on-chain ENS resolution via viem.
//   - read_mm_reputation:   returns neutral 0.0 (Phase 4 implements §7.3 scoring).
//   - read_user_reputation: returns neutral 0.0 (same).
//
// Tools that arrive in Phase 4 (read_trade_history, write_trade_record,
// update_mm_reputation_root) are deliberately not registered yet — adding
// them as no-op stubs would let Hermes call them and silently fail to
// persist anything, which is a worse failure mode than "tool unavailable".

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

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
      "Return a Parley MM's aggregate reputation score in [-0.5, 1.0] alongside trade-count. Phase 2 stub: returns neutral 0.0 (Phase 4 implements SPEC §7.3 scoring on top of 0G Storage TradeRecord blobs).",
    inputSchema: { ens_name: z.string() },
  },
  async ({ ens_name }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ens_name,
              score: 0.0,
              n_trades: 0,
              note: "phase 2 stub — no real reputation data yet",
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
      "Return a user's aggregate reputation score keyed by wallet address (or ENS handle if /register opt-in is used). Phase 2 stub: returns neutral 0.0.",
    inputSchema: { wallet_address: z.string() },
  },
  async ({ wallet_address }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              wallet_address,
              score: 0.0,
              n_trades: 0,
              note: "phase 2 stub — no real reputation data yet",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is reserved for MCP protocol; log to stderr.
process.stderr.write(
  "[og-mcp] connected (resolve_mm, read_mm_reputation, read_user_reputation)\n",
);
