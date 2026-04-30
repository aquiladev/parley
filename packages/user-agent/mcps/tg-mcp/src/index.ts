// tg-mcp — Telegram Bot API primitives Hermes' default adapter doesn't cover.
//
// Why this exists: Hermes can render plain text and InlineKeyboardButtons with
// `callback_data`, but it has no surface for Telegram Mini App `web_app`
// buttons, and its Telegram adapter doesn't dispatch `web_app_data` events
// to the agent. Parley's whole user-side flow (`/connect`, `/sign`, `/settle`,
// `/refund`, `/swap`) is a Mini App, so the agent needs:
//
//   1. A way to render `web_app` buttons (so the URL opens inside Telegram's
//      in-app webview, where `window.Telegram.WebApp` exists and signatures
//      can complete).
//   2. A way to receive callbacks back from the Mini App. We can't use
//      Telegram's native `web_app_data` channel because Hermes ignores it.
//      Instead we run an HTTP relay on this MCP and the Mini App's Next.js
//      `/api/miniapp-result` route POSTs to us over the docker network.
//
// Tools:
//   - send_webapp_button       — single-button message
//   - send_webapp_buttons      — multi-button rows (e.g., [Accept] [Reject])
//   - poll_miniapp_result      — drain the relay inbox for a given tid
//
// Auth: takes the bot token from TELEGRAM_BOT_TOKEN. The same token Hermes
// uses; if it's missing the tools fail open with a clear error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

const TELEGRAM_BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const TELEGRAM_API_BASE = "https://api.telegram.org";

interface WebAppButton {
  text: string;
  web_app: { url: string };
}

interface SendMessageResult {
  ok: true;
  message_id: number;
  chat_id: number | string;
}

type SendMessageEnvelope =
  | SendMessageResult
  | { ok: false; error: string };

async function tgSendMessage(
  chatId: string | number,
  text: string,
  buttons: WebAppButton[][],
): Promise<SendMessageEnvelope> {
  if (!TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      error: "TELEGRAM_BOT_TOKEN is not set in tg-mcp's environment",
    };
  }
  try {
    const url = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      // The agent often passes markdown-flavored text. Telegram's MarkdownV2
      // is strict; HTML mode is more forgiving. We let the agent pass plain
      // text by default — escaping markdown in prose isn't worth the mess.
      reply_markup: { inline_keyboard: buttons },
      disable_web_page_preview: true,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `telegram api ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id: number; chat: { id: number | string } };
    };
    if (!json.ok || !json.result) {
      return {
        ok: false,
        error: `telegram api returned ok=false: ${json.description ?? "unknown"}`,
      };
    }
    return {
      ok: true,
      message_id: json.result.message_id,
      chat_id: json.result.chat.id,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Mini App callback relay. In-memory inbox keyed by Telegram `tid`.
//
// Lifecycle: Hermes spawns this MCP as a long-lived stdio subprocess; the
// HTTP listener stays up alongside. If Hermes ever respawns the MCP the
// inbox is wiped — acceptable for a demo (Mini App callbacks are seconds
// long; the agent polls right after sending the button).
// ---------------------------------------------------------------------------

const RELAY_PORT = Number(process.env["TG_MCP_RELAY_PORT"] ?? "9008");

interface InboxEntry {
  tid: string;
  result: unknown;
  received_at: number;
}

const inbox = new Map<string, InboxEntry>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const relay = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "POST" && req.url === "/miniapp-result") {
    try {
      const text = await readBody(req);
      const body = JSON.parse(text) as { tid?: unknown; result?: unknown };
      if (typeof body.tid !== "string" || !body.tid || typeof body.result !== "object" || body.result === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "tid + result required" }));
        return;
      }
      inbox.set(body.tid, {
        tid: body.tid,
        result: body.result,
        received_at: Date.now(),
      });
      process.stderr.write(`[tg-mcp] relay: stored result for tid=${body.tid}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

relay.on("error", (err) => {
  process.stderr.write(`[tg-mcp] relay listen error: ${err.message}\n`);
});
relay.listen(RELAY_PORT, "0.0.0.0", () => {
  process.stderr.write(`[tg-mcp] relay listening on :${RELAY_PORT}\n`);
});

// ---------------------------------------------------------------------------

const server = new McpServer({ name: "parley-tg-mcp", version: "0.1.0" });

server.registerTool(
  "send_webapp_button",
  {
    description:
      "Send a Telegram message with a single inline web_app button. The button opens `url` inside Telegram's in-app webview, preserving `window.Telegram.WebApp` so the Mini App can sendData(...) back. Use this whenever SOUL.md says 'send a web_app button to /connect?...' or any other Mini App route. `chat_id` is the Telegram chat id of the user the agent is currently talking to. Returns { ok:true, message_id } on success.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]),
      text: z.string(),
      button_label: z.string(),
      url: z.string().url(),
    },
  },
  async ({ chat_id, text, button_label, url }) => {
    process.stderr.write(
      `[tg-mcp] send_webapp_button chat_id=${chat_id} url=${url}\n`,
    );
    const r = await tgSendMessage(chat_id, text, [
      [{ text: button_label, web_app: { url } }],
    ]);
    if (!r.ok) {
      process.stderr.write(
        `[tg-mcp] send_webapp_button FAILED: ${r.error}\n`,
      );
    } else {
      process.stderr.write(
        `[tg-mcp] send_webapp_button ok message_id=${r.message_id}\n`,
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
      isError: !r.ok,
    };
  },
);

server.registerTool(
  "send_webapp_buttons",
  {
    description:
      "Send a Telegram message with multiple inline web_app buttons laid out in rows. Each row is an array of {label, url} pairs. Useful for e.g. surfacing competing offers ([Accept mm-1] [Accept mm-2] [Reject]) where each button opens a different Mini App route. Returns { ok:true, message_id } on success.",
    inputSchema: {
      chat_id: z.union([z.string(), z.number()]),
      text: z.string(),
      rows: z.array(
        z.array(
          z.object({
            label: z.string(),
            url: z.string().url(),
          }),
        ),
      ),
    },
  },
  async ({ chat_id, text, rows }) => {
    const buttons: WebAppButton[][] = rows.map((row) =>
      row.map((b) => ({ text: b.label, web_app: { url: b.url } })),
    );
    const r = await tgSendMessage(chat_id, text, buttons);
    return {
      content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
      isError: !r.ok,
    };
  },
);

server.registerTool(
  "poll_miniapp_result",
  {
    description:
      "Drain the Mini App callback inbox for a Telegram user (`tid`). After you send a web_app button (e.g., /connect, /sign, /settle, /refund, /swap), the Mini App POSTs the user's result here through a Next.js relay. Hermes' Telegram adapter does NOT deliver `web_app_data` events, so polling this tool is the ONLY way to learn whether the user finished the Mini App step. Schedule this every 2s for up to ~120s after sending the button. Returns { ok:true, found:true, result:{ kind, ... } } on a hit, { ok:true, found:false } when the inbox is empty, or { ok:false, error } on transport failure. The matching entry is removed from the inbox on read (drain semantics).",
    inputSchema: {
      tid: z.string(),
    },
  },
  async ({ tid }) => {
    const entry = inbox.get(tid);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, found: false, tid }, null, 2),
          },
        ],
      };
    }
    inbox.delete(tid);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              found: true,
              tid: entry.tid,
              result: entry.result,
              received_at: entry.received_at,
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
process.stderr.write(
  "[tg-mcp] connected (send_webapp_button, send_webapp_buttons, poll_miniapp_result)\n",
);
