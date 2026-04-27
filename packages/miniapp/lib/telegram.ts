// Telegram WebApp bridge — see SPEC §10.3.
// The bot embeds a server-signed JWT in the Mini App URL carrying the deal /
// session payload. After the user signs / submits, we call sendData with the
// result; the bot receives a `web_app_data` event and resumes the flow.

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

export type MiniAppResult =
  | { kind: "session_bound"; wallet: `0x${string}`; sig: `0x${string}`; expires_at: number }
  | { kind: "lock_submitted"; txHash: `0x${string}`; dealId: string }
  | { kind: "settled"; txHash: `0x${string}`; dealId: string }
  | { kind: "refunded"; txHash: `0x${string}`; dealId: string }
  | { kind: "swapped"; txHash: `0x${string}` }
  | { kind: "registered"; txHash: `0x${string}`; handle: string }
  | { kind: "cancelled"; reason?: string };

export function sendResult(result: MiniAppResult): void {
  if (typeof window === "undefined") return;
  const tg = window.Telegram?.WebApp;
  if (!tg) {
    // Local dev outside Telegram — log and noop.
    console.warn("[miniapp] Telegram.WebApp unavailable; result:", result);
    return;
  }
  tg.sendData(JSON.stringify(result));
  tg.close();
}
