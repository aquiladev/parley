import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ProvidersClient } from "./providers-client";
import { TelegramReady } from "../lib/telegram-ready";
import "./globals.css";

// Logo / favicon / OG metadata. Source of truth is /artifacts/ at the repo
// root; assets are mirrored into /public/{favicon,social}/ via the
// `pnpm miniapp:sync-assets` script. See CLAUDE.md "Logos and assets".

export const metadata: Metadata = {
  title: "Parley",
  description: "The agent layer for peer DeFi.",
  icons: {
    icon: [
      // SVG with light/dark variants — modern browsers pick the right one.
      {
        url: "/favicon/favicon-light-64.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/favicon/favicon-dark-64.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
      // PNG fallbacks (legacy browsers).
      { url: "/favicon/favicon-light-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon/favicon-light-16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/favicon/favicon-light.ico",
    apple: { url: "/favicon/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  manifest: "/favicon/manifest.webmanifest",
  openGraph: {
    title: "Parley",
    description: "The agent layer for peer DeFi.",
    images: [
      { url: "/social/og-card-light.png", width: 1200, height: 630, alt: "Parley" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Parley",
    description: "The agent layer for peer DeFi.",
    images: ["/social/og-card-light.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0F0F12",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body>
        <TelegramReady />
        <ProvidersClient>{children}</ProvidersClient>
      </body>
    </html>
  );
}
