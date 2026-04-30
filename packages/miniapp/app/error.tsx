"use client";

// Global Mini App error boundary. Replaces Next.js' default "Application
// error: a client-side exception has occurred (see the browser console)"
// fallback — Telegram's in-app webview does NOT expose a console, so that
// default message is useless to the user.
//
// Render the actual error string + a Reset button. The agent can also see
// what went wrong if the user copy-pastes the message back into Telegram.

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Best-effort log; Telegram webview swallows console.error too, but it's
    // visible if the user opens the same URL in a regular browser tab.
    // eslint-disable-next-line no-console
    console.error("[miniapp] uncaught render error:", error);
  }, [error]);

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "system-ui",
        lineHeight: 1.5,
        maxWidth: 480,
      }}
    >
      <h1 style={{ marginBottom: 8 }}>Something went wrong</h1>
      <p style={{ color: "var(--parley-hint)", fontSize: 13, marginTop: 0 }}>
        The Mini App hit an unexpected error. Detail below — share with support
        or screenshot if you reach out.
      </p>
      <pre
        style={{
          background: "var(--parley-secondary-bg)",
          padding: "12px 14px",
          borderRadius: 8,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: "12px 0",
        }}
      >
        {error.name}: {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <button
        onClick={() => reset()}
        style={{
          background: "var(--parley-btn-bg)",
          color: "var(--parley-btn-fg)",
          padding: "12px 20px",
          fontSize: 16,
          borderRadius: 8,
          border: "none",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  );
}
