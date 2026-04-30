// Telegram WebApp bridge — see SPEC §10.3.
// The bot embeds a server-signed JWT in the Mini App URL carrying the deal /
// session payload. After the user signs / submits we deliver the result to
// the agent via TWO channels (we need both):
//
//   1. `Telegram.WebApp.sendData(...)` — Telegram's native callback. Hermes'
//      Telegram adapter doesn't actually handle `web_app_data` events
//      (verified empirically), but `sendData` also closes the webview
//      automatically, which is the right UX even if the bot never sees it.
//
//   2. POST /api/miniapp-result — our own relay. The Mini App's Next.js API
//      route forwards over the docker network to tg-mcp, which holds an
//      in-memory inbox keyed by Telegram `tid`. The agent polls
//      `mcp_parley_tg_poll_miniapp_result({ tid })` after sending each
//      web_app button.
//
// `tid` comes from the URL the bot embedded in the web_app button.

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        sendData: (data: string) => void;
        close: () => void;
        ready: () => void;
      };
    };
  }
}

// Wire format the Mini App sends back to the bot via Telegram.WebApp.sendData.
// Each kind is the payload for one user-driven action; the bot's gateway
// receives it as a `web_app_data` event and resumes the agent loop.

/** Reasons the user / Mini App can cancel an in-flight action. Discriminated
 *  so SOUL.md can branch deterministically on each. The reason set is small
 *  on purpose: anything not covered here means "we don't have a structured
 *  signal" and the agent falls back to the generic polling timeout.
 *
 *  - `wallet_mismatch`: connected wallet differs from the SessionBinding wallet.
 *  - `offer_expired`: `deal.deadline` is in the past — signing now would just
 *    burn gas (the contract reverts on stale deadlines). The agent should
 *    quote a fresh intent rather than retry with the same offer.
 *  - `user_rejected`: explicit "Cancel" without a more specific reason. */
export type CancelReason = "wallet_mismatch" | "offer_expired" | "user_rejected";

export type MiniAppResult =
  | {
      kind: "session_bound";
      wallet: `0x${string}`;
      sig: `0x${string}`;
      expires_at: number;
    }
  | {
      kind: "intent_authorized";
      intent_id: string;
      auth: { intent_id: string; telegram_user_id: string; issued_at: number };
      sig: `0x${string}`;
    }
  | {
      kind: "lock_submitted";
      txHash: `0x${string}`;
      dealId: string;
      deal_sig: `0x${string}`;
      accept_auth: {
        offer_id: string;
        deal_hash: `0x${string}`;
        telegram_user_id: string;
        issued_at: number;
      };
      accept_auth_sig: `0x${string}`;
    }
  | { kind: "settled"; txHash: `0x${string}`; dealId: string }
  | { kind: "refunded"; txHash: `0x${string}`; dealId: string }
  | { kind: "swapped"; txHash: `0x${string}` }
  | { kind: "registered"; txHash: `0x${string}`; handle: string }
  | {
      kind: "cancelled";
      reason: CancelReason;
      /** Wallet the SessionBinding was created with (from the action URL's
       *  `?wallet=` param). Populated when reason === "wallet_mismatch". */
      expected_wallet?: `0x${string}`;
      /** Wallet currently connected in the Mini App. Same conditional. */
      got_wallet?: `0x${string}`;
    };

/** Read the `tid` query param from the current URL. The bot bakes this into
 *  every web_app button URL so we can correlate results to a Telegram user. */
function readTid(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("tid");
}

export async function sendResult(result: MiniAppResult): Promise<void> {
  if (typeof window === "undefined") return;

  // Channel 2: our relay. Fire and forget — the agent polls the inbox.
  // Done first because `tg.close()` (channel 1) may unmount the JS context
  // before the fetch resolves on some Telegram clients.
  const tid = readTid();
  if (tid) {
    try {
      await fetch("/api/miniapp-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tid, result }),
        keepalive: true,
      });
    } catch (err) {
      // Don't block UX if the relay is unreachable — Telegram's sendData
      // still fires, and the agent's polling loop will eventually time out.
      console.warn("[miniapp] relay POST failed:", err);
    }
  }

  // Channel 1: Telegram's native sendData. Auto-closes the webview.
  const tg = window.Telegram?.WebApp;
  if (!tg) {
    console.warn("[miniapp] Telegram.WebApp unavailable; result:", result);
    return;
  }
  tg.sendData(JSON.stringify(result));
  tg.close();
}

/** Convenience wrapper for the most common cancellation surface. The Mini App
 *  routes call this when the user taps "Cancel" on a wallet-mismatch screen,
 *  or when they explicitly reject inside their wallet and we want to bubble
 *  the reason back to the agent instead of staying stuck. */
export function sendCancel(
  reason: CancelReason,
  extras: { expected_wallet?: `0x${string}`; got_wallet?: `0x${string}` } = {},
): Promise<void> {
  return sendResult({ kind: "cancelled", reason, ...extras });
}
