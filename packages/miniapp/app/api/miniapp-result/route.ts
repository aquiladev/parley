// Mini App callback relay.
//
// The Mini App posts here after a sign / submit; we forward over the docker
// network to tg-mcp's HTTP listener. tg-mcp holds an in-memory inbox keyed by
// Telegram `tid`; the agent polls `mcp_parley_tg_poll_miniapp_result({ tid })`
// to drain it.
//
// This route exists because Hermes' Telegram adapter doesn't dispatch
// `web_app_data` events to the agent — see lib/telegram.ts comment.
//
// Trust model: we don't verify Telegram's `initData` HMAC here yet. For the
// Sepolia testnet demo this is acceptable (any forged callback can be
// replicated by the user themselves, and the agent's privileged-tool checks
// re-verify wallet signatures on every state-changing action). Production
// should validate `initData` against `TELEGRAM_BOT_TOKEN` per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.

import { NextResponse } from "next/server";

// Where tg-mcp listens. Same docker network — service name + port.
const RELAY_URL =
  process.env["MINIAPP_RELAY_URL"] ?? "http://user-agent:9008/miniapp-result";

interface RelayBody {
  tid?: unknown;
  result?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  let body: RelayBody;
  try {
    body = (await req.json()) as RelayBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  if (typeof body.tid !== "string" || !body.tid) {
    return NextResponse.json({ ok: false, error: "tid required" }, { status: 400 });
  }
  if (typeof body.result !== "object" || body.result === null) {
    return NextResponse.json({ ok: false, error: "result required" }, { status: 400 });
  }

  try {
    const r = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tid: body.tid, result: body.result }),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `relay ${r.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
