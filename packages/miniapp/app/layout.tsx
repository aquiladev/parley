import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ProvidersClient } from "./providers-client";

export const metadata: Metadata = {
  title: "Parley",
  description: "Sign and submit Parley trades from inside Telegram",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body>
        <ProvidersClient>{children}</ProvidersClient>
      </body>
    </html>
  );
}
