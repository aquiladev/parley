"use client";

// Theme detection that works both inside Telegram's in-app webview AND in a
// regular browser tab.
//
// Telegram does NOT propagate its in-app theme to the OS-level
// `prefers-color-scheme` media query — instead it injects its own
// `--tg-theme-*` CSS variables and exposes `Telegram.WebApp.colorScheme`
// (`"dark"` | `"light"`). The CSS variables cover backgrounds and text;
// they don't help us pick between two SVG sources for the logo.
//
// This hook resolves the truth in priority order:
//   1. Telegram.WebApp.colorScheme — authoritative when running inside
//      Telegram. Updates when the user toggles their Telegram theme via
//      the `themeChanged` event.
//   2. window.matchMedia("(prefers-color-scheme: dark)") — fallback for
//      regular browser tabs and for Telegram clients that don't expose
//      `colorScheme` (older Telegram versions).
//
// Returns `false` during SSR. The first client-side render after hydration
// may flicker if dark; live with it (avoiding the flicker requires either
// a server-side cookie hint or rendering the logo as a CSS background that
// reacts to a class set in a <head> script — both are out of scope).

import { useEffect, useState } from "react";

interface TelegramWebAppLike {
  colorScheme?: "dark" | "light";
  onEvent?: (event: string, cb: () => void) => void;
  offEvent?: (event: string, cb: () => void) => void;
}

function getTg(): TelegramWebAppLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebAppLike } })
    .Telegram?.WebApp;
}

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const compute = (): boolean => {
      const tg = getTg();
      if (tg?.colorScheme === "dark") return true;
      if (tg?.colorScheme === "light") return false;
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    };

    const update = () => setDark(compute());
    update();

    // Telegram fires `themeChanged` when the user toggles their app theme.
    const tg = getTg();
    tg?.onEvent?.("themeChanged", update);

    // OS-level fallback for browser-tab users who toggle dark mode.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", update);

    return () => {
      tg?.offEvent?.("themeChanged", update);
      mq?.removeEventListener?.("change", update);
    };
  }, []);

  return dark;
}
