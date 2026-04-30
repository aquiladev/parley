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

// CRITICAL: redirect console.* to stderr BEFORE any other imports.
// `@0gfoundation/0g-ts-sdk` writes "Starting upload for file of size..." and
// similar progress lines to stdout via console.log during upload. This MCP
// uses stdio transport, where stdout is reserved for JSON-RPC messages — any
// non-JSON output corrupts the protocol stream and Hermes' MCP client throws
// `pydantic_core.ValidationError: Invalid JSON: expected value at line 1`.
// The MCP SDK's StdioServerTransport uses `process.stdout.write` directly,
// not `console.*`, so silencing console doesn't affect protocol output.
const _redirected = (msg: unknown): void => {
  const text = typeof msg === "string" ? msg : JSON.stringify(msg);
  process.stderr.write(`[og-mcp:console] ${text}\n`);
};
console.log = (...args: unknown[]): void => _redirected(args.map(String).join(" "));
console.info = console.log;
console.warn = console.log;
console.debug = console.log;
// console.error → keep going to stderr natively (already harmless).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
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
import { fetchMmIndexBlob, fetchTradeRecord, uploadTradeRecord } from "./storage.js";
import {
  computeSavingsBps,
  getUniswapQuote,
  prepareFallbackSwap,
} from "./uniswap.js";

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
      "Return a Parley MM's aggregate reputation score in [-0.5, 1.0] alongside trade-count, keyed by ENS name. Reads via the canonical ENS path (SPEC §4.4): resolves ens_name → text('reputation_root') → fetches index blob from 0G Storage → fetches each TradeRecord. Falls back to og-mcp's local index if the ENS pointer is unset. Implements SPEC §7.3 scoring (SMOOTHING=5, MM_TIMEOUT_WEIGHT=0.5).",
    inputSchema: { ens_name: z.string() },
  },
  async ({ ens_name }) => {
    let rootHashes: string[] = [];
    let source: "ens" | "local" | "none" = "none";

    // Canonical path: ENS reputation_root → index blob → records.
    let name: string;
    try {
      name = normalize(ens_name);
    } catch {
      name = ens_name;
    }
    try {
      const reputationRoot = await client.getEnsText({ name, key: "reputation_root" });
      if (reputationRoot && reputationRoot.startsWith("0x")) {
        const blob = await fetchMmIndexBlob(reputationRoot);
        rootHashes = blob.records;
        source = "ens";
      }
    } catch (err) {
      process.stderr.write(
        `[og-mcp] reputation_root fetch failed for ${ens_name}: ${(err as Error).message}\n`,
      );
    }

    // Fallback: local index (mostly empty for MMs the og-mcp host doesn't
    // know about, but useful for the User Agent's own past trades).
    if (rootHashes.length === 0) {
      const local = listMMRecords(ens_name);
      if (local.length > 0) {
        rootHashes = local;
        source = "local";
      }
    }

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
              source,
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

// ---- Uniswap tools (Phase 5) ------------------------------------------------

const TokenRefSchema = z.object({
  chain_id: z.number(),
  address: z.string(),
  symbol: z.string(),
  decimals: z.number(),
});

// Subset of the full Intent envelope — `prepare_fallback_swap` and
// `get_uniswap_reference_quote` only need the trade legs and slippage;
// the rest of Intent (signatures, AXL pubkeys, etc.) is irrelevant here.
const FallbackIntentSchema = z.object({
  side: z.enum(["buy", "sell"]),
  base: TokenRefSchema,
  quote: TokenRefSchema,
  amount: z.string(),
  max_slippage_bps: z.number(),
});

server.registerTool(
  "prepare_fallback_swap",
  {
    description:
      "Build Uniswap calldata for a swap matching `intent`, executed from `user_address`'s wallet on Sepolia. Hits the Trading API's /check_approval, /quote, and /swap endpoints (SPEC §9.1). Returns { ok:true, value:{ to, data, value, approvalRequired?, permit2Required?, expectedInput, expectedOutput, route } } that the Mini App's /swap route consumes. On API/network error returns { ok:false, error } so the bot can degrade gracefully (no fallback button).",
    inputSchema: {
      intent: FallbackIntentSchema,
      user_address: z.string(),
    },
  },
  async ({ intent, user_address }) => {
    const result = await prepareFallbackSwap(
      intent as Parameters<typeof prepareFallbackSwap>[0],
      user_address as `0x${string}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  },
);

server.registerTool(
  "get_uniswap_reference_quote",
  {
    description:
      "Reference price for `intent` from Uniswap v3 (on-chain QuoterV2; no calldata build). Used during offer evaluation to compute the `vs Uniswap` line on the offer card. Pass `peer_amount_out_wei` (the MM offer's amountB) to get the comparison fields filled in. " +
      "On success returns `{ ok:true, value:{ amountOut, amountOutWei, amountInWei, effectivePrice, feeTier, route, " +
      "peer_amount_out_wei?, uniswap_amount_out_wei?, peer_better_than_uniswap?, peer_advantage_bps? } }`. " +
      "**Sign convention:** `peer_advantage_bps` is signed — POSITIVE means the peer offers MORE output tokens than Uniswap (good for the user; surface as 'saves X% vs Uniswap'); NEGATIVE means the peer offers LESS (bad; surface as 'X% worse than Uniswap'). Always cross-check by comparing `peer_amount_out_wei` directly against `uniswap_amount_out_wei` — peer_better_than_uniswap is precomputed from that comparison so you can trust the boolean even if the bps math feels off.",
    inputSchema: {
      intent: FallbackIntentSchema,
      swapper: z.string(),
      peer_amount_out_wei: z.string().optional(),
    },
  },
  async ({ intent, swapper, peer_amount_out_wei }) => {
    const result = await getUniswapQuote(
      intent as Parameters<typeof getUniswapQuote>[0],
      swapper as `0x${string}`,
    );
    if (!result.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: true,
      };
    }
    const enriched: Record<string, unknown> = { ...result.value };
    if (peer_amount_out_wei !== undefined) {
      try {
        const peerWei = BigInt(peer_amount_out_wei);
        const uniswapWei = BigInt(result.value.amountOutWei);
        // Pre-compute multiple redundant signals so the agent has more than
        // one way to read the comparison. The historic `savings_bps_vs_peer`
        // name was ambiguous — "vs peer" could mean either direction. The
        // new `peer_advantage_bps` is unambiguous: POSITIVE = peer is the
        // better deal for the user.
        enriched["peer_amount_out_wei"] = peerWei.toString();
        enriched["uniswap_amount_out_wei"] = uniswapWei.toString();
        enriched["peer_better_than_uniswap"] = peerWei > uniswapWei;
        enriched["peer_advantage_bps"] = computeSavingsBps(peerWei, uniswapWei);
      } catch (err) {
        enriched["comparison_error"] = (err as Error).message;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, value: enriched }, null, 2),
        },
      ],
    };
  },
);

// ---- Settlement state polling tool ----------------------------------------
//
// The agent can't see chain events itself — Hermes' Telegram adapter has no
// chain-watcher integration, and the AXL sidecar's chain logs go to stdout
// for ops, not to Hermes' inbox. So after the user submits `lockUserSide`,
// the agent has no signal that the MM has counter-locked unless it polls.
//
// This tool exposes Settlement.getState(dealHash) so SOUL.md's "Settlement"
// section can schedule a tight poll between `lock_submitted` and either
// BothLocked (→ surface /settle) or deadline-elapsed-while-still-UserLocked
// (→ surface /refund).

const SETTLEMENT_ADDRESS = process.env["SETTLEMENT_CONTRACT_ADDRESS"] as
  | Hex
  | undefined;

const SETTLEMENT_GET_STATE_ABI = parseAbi([
  "function getState(bytes32 dealHash) external view returns (uint8)",
]);

const SETTLEMENT_STATE_NAMES = [
  "None",        // 0 — deal hash never seen on-chain
  "UserLocked",  // 1 — user called lockUserSide
  "BothLocked",  // 2 — MM has counter-locked; settle() can run
  "Settled",     // 3 — settle() succeeded; tokens swapped
  "Refunded",    // 4 — refund() called after deadline
] as const;

// Token registry for /balance — Sepolia testnet only. Addresses come from
// env so the same .env that the MM Agent reads (live `balanceOf` quoting)
// stays the source of truth.
const USDC_ADDRESS = process.env["SEPOLIA_USDC_ADDRESS"] as Hex | undefined;
const WETH_ADDRESS = process.env["SEPOLIA_WETH_ADDRESS"] as Hex | undefined;

const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function formatUnits(wei: bigint, decimals: number): string {
  if (decimals === 0) return wei.toString();
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

server.registerTool(
  "read_settlement_state",
  {
    description:
      "Read the on-chain state of a Parley Settlement deal by its deal_hash. Use this AFTER receiving `lock_submitted` from /sign to detect when the MM counter-locks (state moves UserLocked → BothLocked, your cue to send the /settle button), and before sending /refund (state must be UserLocked or BothLocked AND deal.deadline must have passed). Returns { ok: true, state: 'None' | 'UserLocked' | 'BothLocked' | 'Settled' | 'Refunded', state_int: 0..4 } or { ok: false, error }. Recommended polling cadence: every 10s for up to 3× deal.deadline window after lock_submitted; back off to every 30s past deadline. Cheap call (single eth_call); no signature required.",
    inputSchema: {
      deal_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    },
  },
  async ({ deal_hash }) => {
    if (!SETTLEMENT_ADDRESS) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: "SETTLEMENT_CONTRACT_ADDRESS not set in og-mcp env",
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    try {
      const stateInt = (await client.readContract({
        address: SETTLEMENT_ADDRESS,
        abi: SETTLEMENT_GET_STATE_ABI,
        functionName: "getState",
        args: [deal_hash as Hex],
      })) as number;
      const state =
        SETTLEMENT_STATE_NAMES[Number(stateInt)] ?? `Unknown(${stateInt})`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, deal_hash, state, state_int: Number(stateInt) },
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
              { ok: false, error: (err as Error).message },
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

// /balance command surface. Reads native ETH + the two ERC20 tokens Parley
// trades on Sepolia (USDC, WETH) in one call. Returns both wei (string, for
// precise comparisons) and human-formatted decimals so the agent can render
// without doing math.
server.registerTool(
  "read_wallet_balance",
  {
    description:
      "Read a wallet's native ETH and ERC20 (USDC, WETH) balances on Sepolia. Use this for the /balance command. Returns { ok: true, wallet, balances: { eth: { wei, formatted }, usdc: { wei, formatted, decimals: 6, address }, weth: { wei, formatted, decimals: 18, address } } }. Cheap (one eth_getBalance + two eth_call). On RPC failure returns { ok: false, error }.",
    inputSchema: {
      wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    },
  },
  async ({ wallet }) => {
    if (!USDC_ADDRESS || !WETH_ADDRESS) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error:
                  "SEPOLIA_USDC_ADDRESS / SEPOLIA_WETH_ADDRESS not set in og-mcp env (check hermes-config/config.yaml mcp_servers.parley_og.env)",
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const addr = wallet as Hex;
    try {
      const [ethWei, usdcWei, wethWei] = await Promise.all([
        client.getBalance({ address: addr }),
        client.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [addr],
        }) as Promise<bigint>,
        client.readContract({
          address: WETH_ADDRESS,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [addr],
        }) as Promise<bigint>,
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                wallet: addr,
                balances: {
                  eth: { wei: ethWei.toString(), formatted: formatUnits(ethWei, 18), decimals: 18 },
                  usdc: {
                    wei: usdcWei.toString(),
                    formatted: formatUnits(usdcWei, 6),
                    decimals: 6,
                    address: USDC_ADDRESS,
                  },
                  weth: {
                    wei: wethWei.toString(),
                    formatted: formatUnits(wethWei, 18),
                    decimals: 18,
                    address: WETH_ADDRESS,
                  },
                },
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
              { ok: false, wallet: addr, error: (err as Error).message },
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
  "[og-mcp] connected (resolve_mm, read_mm_reputation, read_user_reputation, " +
    "write_trade_record, read_trade_history, prepare_fallback_swap, " +
    "get_uniswap_reference_quote, read_settlement_state, read_wallet_balance)\n",
);
