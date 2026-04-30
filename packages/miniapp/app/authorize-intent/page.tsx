// /authorize-intent — sign IntentAuthorization (SPEC §4.3).
//
// One of the four §4.3 privileged-tool checks for `axl-mcp.broadcast_intent`.
// The user signs an IntentAuthorization typed-data binding the intent_id to
// their telegram_user_id and a fresh `issued_at` timestamp; the MCP rejects
// any broadcast call whose action sig doesn't recover to the same wallet
// that signed the SessionBinding.
//
// URL: /authorize-intent?tid=<telegram_user_id>&intent=<URL-encoded JSON Intent>

"use client";

import { Suspense, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import {
  INTENT_AUTHORIZATION_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  type Intent,
} from "@parley/shared";
import { sendCancel, sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";
import { MiniAppHeader } from "../../lib/header";
import { formatTxError } from "../../lib/tx-error";

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AuthIntentInner() {
  const params = useSearchParams();
  const tid = params.get("tid");
  const intentJson = params.get("intent");

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intent = useMemo<Intent | null>(() => {
    if (!intentJson) return null;
    try {
      const parsed = JSON.parse(intentJson) as Intent;
      // Defensive shape check — if the agent omits a required field, the
      // page render below would crash on e.g. `intent.base.symbol`. Bail
      // cleanly so the Page-level "Malformed intent JSON" branch fires.
      if (
        !parsed.id ||
        !parsed.agent_id ||
        !parsed.side ||
        !parsed.base ||
        typeof parsed.base.symbol !== "string" ||
        !parsed.quote ||
        typeof parsed.quote.symbol !== "string" ||
        typeof parsed.amount !== "string" ||
        typeof parsed.max_slippage_bps !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, [intentJson]);

  if (!tid || !intentJson) {
    return (
      <Page>
        <h1>Authorize intent</h1>
        <ErrLine>
          Missing <code>tid</code> or <code>intent</code> in URL.
        </ErrLine>
      </Page>
    );
  }
  if (!intent) {
    // Surface the raw payload + which required fields are missing so the
    // operator can pinpoint what the agent built. Otherwise the user sees
    // only "Malformed intent JSON" with no way to recover.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(intentJson) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const required: Array<[string, (v: unknown) => boolean]> = [
      ["id", (v) => typeof v === "string" && v.length > 0],
      ["agent_id", (v) => typeof v === "string" && v.startsWith("0x")],
      ["side", (v) => v === "buy" || v === "sell"],
      ["base", (v) => typeof v === "object" && v !== null && typeof (v as { symbol?: unknown }).symbol === "string"],
      ["quote", (v) => typeof v === "object" && v !== null && typeof (v as { symbol?: unknown }).symbol === "string"],
      ["amount", (v) => typeof v === "string"],
      ["max_slippage_bps", (v) => typeof v === "number"],
    ];
    const missing = parsed
      ? required.filter(([k, ok]) => !ok((parsed as Record<string, unknown>)[k])).map(([k]) => k)
      : ["<unparseable>"];
    return (
      <Page>
        <h1>Authorize intent</h1>
        <ErrLine>Malformed intent JSON.</ErrLine>
        <p style={{ fontSize: 13, color: "var(--parley-hint)", marginTop: 12 }}>
          Missing or wrong-typed fields:
        </p>
        <pre
          style={{
            background: "var(--parley-secondary-bg)",
            padding: "10px 12px",
            borderRadius: 8,
            fontSize: 12,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {missing.join(", ") || "(shape ok but other validation failed)"}
        </pre>
        <p style={{ fontSize: 13, color: "var(--parley-hint)", marginTop: 12 }}>
          Raw payload received:
        </p>
        <pre
          style={{
            background: "var(--parley-secondary-bg)",
            padding: "10px 12px",
            borderRadius: 8,
            fontSize: 11,
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
          }}
        >
          {parsed ? JSON.stringify(parsed, null, 2) : intentJson}
        </pre>
      </Page>
    );
  }

  if (isConnected && address && intent.agent_id.toLowerCase() !== address.toLowerCase()) {
    // Hard block: signing here would produce an IntentAuthorization that
    // recovers to the wrong wallet, which broadcast_intent rejects with
    // BINDING_MISMATCH server-side. Better to bail loudly with a Cancel
    // button that signals the agent so it can recover, instead of a
    // dead-end red message that leaves the user stranded.
    const expected = intent.agent_id;
    const got = address;
    return (
      <Page>
        <h1>Wrong wallet</h1>
        <p style={{ color: "var(--parley-hint)", marginTop: 0 }}>
          The bot is expecting one wallet, you're connected with another. Pick
          one of the recovery options below — the bot will guide you through
          the rest.
        </p>
        <ul style={list}>
          <li><b>Bot expects:</b> <code>{shortAddr(expected)}</code></li>
          <li><b>You're connected:</b> <code>{shortAddr(got)}</code></li>
        </ul>
        <button
          onClick={() => {
            disconnect();
            sendCancel("wallet_mismatch", {
              expected_wallet: expected as `0x${string}`,
              got_wallet: got as `0x${string}`,
            });
          }}
          style={btn}
        >
          Cancel and return to bot
        </button>
      </Page>
    );
  }

  async function authorizeAndReturn() {
    if (!address || !intent || !tid) return;
    setError(null);
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }
      const issuedAt = Math.floor(Date.now() / 1000);
      const auth = {
        intent_id: intent.id,
        telegram_user_id: tid,
        issued_at: issuedAt,
      };
      const sig = await signTypedDataAsync({
        domain: PARLEY_EIP712_DOMAIN,
        types: INTENT_AUTHORIZATION_EIP712_TYPES,
        primaryType: "IntentAuthorization",
        message: {
          intent_id: auth.intent_id,
          telegram_user_id: BigInt(auth.telegram_user_id),
          issued_at: BigInt(auth.issued_at),
        },
      });
      sendResult({ kind: "intent_authorized", intent_id: intent.id, auth, sig });
      setDone(true);
    } catch (err) {
      setError(formatTxError(err));
    }
  }

  if (done) {
    return (
      <Page>
        <h1>Authorized ✓</h1>
        <p>Return to Telegram to continue.</p>
      </Page>
    );
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Authorize intent</h1>
        <p style={{ color: "var(--parley-hint)" }}>
          Connect wallet <code>{shortAddr(intent.agent_id)}</code> to continue.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {connectors.map((c) => (
            <button
              key={c.uid}
              onClick={() => connect({ connector: c })}
              disabled={connecting}
              style={btn}
            >
              {connecting ? "Connecting…" : `Connect via ${connectorLabel(c)}`}
            </button>
          ))}
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <h1>Authorize intent</h1>
      <ul style={list}>
        <li><b>{intent.side === "sell" ? "Sell" : "Buy"}</b> {intent.amount} {intent.base.symbol}{" "}
          {intent.side === "sell" ? "for" : "with"} {intent.quote.symbol}</li>
        <li><b>Slippage:</b> {intent.max_slippage_bps / 100}%</li>
        <li><b>Telegram user:</b> {tid}</li>
        <li><b>Intent id:</b> <code>{intent.id.slice(0, 12)}…</code></li>
      </ul>
      <p style={{ fontSize: 13, color: "var(--parley-hint)" }}>
        This signature authorizes the bot to broadcast the above intent to MMs on your behalf.
        It is <b>not</b> a transaction.
      </p>
      <button
        onClick={authorizeAndReturn}
        disabled={signing || switching}
        style={btn}
      >
        {switching ? "Switching to Sepolia…" : signing ? "Signing…" : "Authorize"}
      </button>
      {error && <ErrLine>{error}</ErrLine>}
    </Page>
  );
}

export default function AuthIntent() {
  return (
    <Suspense fallback={<Page><p>Loading…</p></Page>}>
      <AuthIntentInner />
    </Suspense>
  );
}

// ---- helpers --------------------------------------------------------------

interface ConnectorLike {
  type?: string;
  name?: string;
}
function connectorLabel(c: ConnectorLike): string {
  if (c.name && c.name.trim() !== "") return c.name;
  if (c.type === "walletConnect") return "WalletConnect (QR)";
  if (c.type === "injected") return "Browser extension";
  if (c.type === "coinbaseWallet") return "Coinbase Wallet";
  return c.type ?? "Wallet";
}

const btn: React.CSSProperties = {
  background: "var(--parley-btn-bg)",
  color: "var(--parley-btn-fg)",
  padding: "12px 20px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
};

const list: React.CSSProperties = {
  background: "var(--parley-secondary-bg)",
  borderRadius: 8,
  padding: "12px 20px",
  listStyle: "none",
};

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}>
      <MiniAppHeader />
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--parley-error)", marginTop: 12, wordBreak: "break-word" }}>{children}</p>;
}
