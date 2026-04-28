"use client";

// Client-only loader for Providers.
//
// The wagmi connectors (`injected()`, `coinbaseWallet()`) touch browser-only
// APIs (window, indexedDB, localStorage) at module import time. That breaks
// Next.js's server-side page-data collection during `next build`. The fix is
// to skip the Providers subtree entirely at SSR — `next/dynamic({ ssr: false })`
// renders the loader as null at build time, then mounts Providers (and all
// its children) only after hydration. Wagmi hooks inside child pages are
// safe because they don't run until the browser has the providers in place.
//
// This file must stay a Client Component because `ssr: false` is only valid
// in dynamic() calls made from client modules.

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

const Providers = dynamic(
  () => import("./providers").then((m) => m.Providers),
  { ssr: false },
);

export function ProvidersClient({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
