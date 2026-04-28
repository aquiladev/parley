// og-mcp — MCP server for 0G Storage reads/writes + ENS resolution.
// SPEC §4.3, §4.4, §7.
//
// Phase 2 status:
//   - resolve_mm:           hardcoded map keyed by ENS name. Same return
//                           shape as the post-Phase-3 viem-based resolver.
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
import type { Hex } from "viem";

interface MmResolution {
  ens_name: string;
  addr: Hex;
  axl_pubkey: string; // full 64-hex ed25519 pubkey
  agent_capabilities: { chain: string; pairs: string[] };
  reputation_root: Hex | null;
  avatar: string | null;
}

// Phase 2 hardcoded map. Phase 3 replaces this body with viem.getEnsAddress
// + getEnsText. Same return shape — no caller changes needed.
const MM_RESOLUTIONS: Record<string, MmResolution> = {
  "mm-1.parley.eth": {
    ens_name: "mm-1.parley.eth",
    addr: "0x7741114B2e5f7ff976660A00b2B548245C672B64",
    axl_pubkey:
      "1edb9063f1e26aec0ea50ed903635692754ee2479e2fa0d66397de31cbdfd2d9",
    agent_capabilities: { chain: "sepolia", pairs: ["USDC/WETH"] },
    reputation_root: null,
    avatar: null,
  },
};

const server = new McpServer({ name: "parley-og-mcp", version: "0.1.0" });

server.registerTool(
  "resolve_mm",
  {
    description:
      "Resolve a Parley MM ENS subname (e.g., mm-1.parley.eth) to its EVM address, AXL public key, capabilities, and reputation root. Phase 2: hardcoded map; Phase 3: real on-chain ENS resolution.",
    inputSchema: { ens_name: z.string() },
  },
  async ({ ens_name }) => {
    const r = MM_RESOLUTIONS[ens_name];
    if (!r) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "unknown_mm", ens_name }, null, 2),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
    };
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
