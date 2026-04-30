"use client";

// Shared Mini App header. Renders the Parley lockup so every page has a
// consistent brand mark in Telegram's webview chrome.
//
// Theme awareness goes through `useDarkMode` rather than `<picture media>`:
// Telegram's in-app webview applies its own theme via `--tg-theme-*` CSS
// variables but does NOT sync `prefers-color-scheme`, so a `<picture>`
// media query for dark mode silently never matches inside Telegram. We
// detect via `Telegram.WebApp.colorScheme` and fall back to OS media query
// for browser-tab use.
//
// Both assets are mirrored into /public/ via `pnpm miniapp:sync-assets`.

import { useDarkMode } from "./use-dark-mode";

export function MiniAppHeader() {
  const dark = useDarkMode();
  // The dark variant ships only as the bare mark; we don't have a dark
  // lockup-with-wordmark in /artifacts/. The light variant is the full
  // horizontal lockup. Sizes differ slightly to compensate.
  const src = dark ? "/mark-on-dark.svg" : "/lockup-horizontal.svg";
  const width = dark ? 48 : 180;
  const height = dark ? 48 : 36;

  return (
    <div style={{ marginBottom: 16 }}>
      <img
        src={src}
        alt="Parley"
        width={width}
        height={height}
        style={{ display: "block" }}
      />
    </div>
  );
}
