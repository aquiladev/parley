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
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import {
  INTENT_AUTHORIZATION_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  type Intent,
} from "@parley/shared";
import { sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";

function AuthIntentInner() {
  const params = useSearchParams();
  const tid = params.get("tid");
  const intentJson = params.get("intent");

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intent = useMemo<Intent | null>(() => {
    if (!intentJson) return null;
    try {
      return JSON.parse(intentJson) as Intent;
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
    return (
      <Page>
        <h1>Authorize intent</h1>
        <ErrLine>Malformed intent JSON.</ErrLine>
      </Page>
    );
  }

  if (isConnected && address && intent.agent_id.toLowerCase() !== address.toLowerCase()) {
    return (
      <Page>
        <h1>Wrong wallet</h1>
        <ErrLine>
          Intent binds <code>{intent.agent_id.slice(0, 10)}…</code>; connected wallet is{" "}
          <code>{address.slice(0, 10)}…</code>.
        </ErrLine>
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
      setError((err as Error).message);
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
        <p style={{ opacity: 0.7 }}>Connect your wallet to continue.</p>
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
      <p style={{ fontSize: 13, opacity: 0.7 }}>
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
  padding: "12px 20px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  background: "#0066ff",
  color: "white",
  cursor: "pointer",
};

const list: React.CSSProperties = {
  background: "#f6f6f6",
  borderRadius: 8,
  padding: "12px 20px",
  listStyle: "none",
};

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}>
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "crimson", marginTop: 12, wordBreak: "break-word" }}>{children}</p>;
}
