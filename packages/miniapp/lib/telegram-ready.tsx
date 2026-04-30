"use client";

// Telegram Mini App lifecycle bridge. Without `ready()`, Telegram's iOS/Android
// clients overlay a loading splash on top of our page indefinitely — the page
// renders fine in the DOM but the user only sees Telegram's spinner. Calling
// `ready()` once on mount tells Telegram "go ahead and show the webview".
//
// `expand()` is a polish touch: it pushes the webview to full height so the
// user doesn't have to drag the sheet up.
//
// Mount this in the root layout. No-op outside a Telegram webview (the script
// tag in layout.tsx loads the SDK async; if it isn't ready yet, we retry once
// after a short delay).

import { useEffect } from "react";

export function TelegramReady() {
  useEffect(() => {
    const fire = () => {
      const tg = (window as unknown as {
        Telegram?: { WebApp?: { ready?: () => void; expand?: () => void } };
      }).Telegram?.WebApp;
      if (!tg) return false;
      tg.ready?.();
      tg.expand?.();
      return true;
    };
    if (!fire()) {
      // Layout's <script async> may not have loaded yet on first paint; retry
      // a few times before giving up. Outside Telegram, this just no-ops.
      let attempts = 0;
      const id = setInterval(() => {
        attempts += 1;
        if (fire() || attempts >= 10) clearInterval(id);
      }, 200);
      return () => clearInterval(id);
    }
  }, []);
  return null;
}
