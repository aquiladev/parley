// /connect — Phase 2 onboarding flow (SPEC §4.5.1, §10.2).
//
// 1. WalletConnect — user pairs their wallet (Phase 0 #8 wired this).
// 2. SessionBinding EIP-712 — user signs `{telegram_user_id, wallet, expires_at}`
//    so the bot's privileged tools can verify per-call that the Telegram-user
//    asking for an action also owns the wallet that signed the session.
// 3. Mini App returns the binding + sig to the bot via Telegram.WebApp.sendData.
//
// Open via: <miniapp-base>/connect?tid=<telegram_user_id>

"use client";

import { Suspense, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import {
  PARLEY_EIP712_DOMAIN,
  SESSION_BINDING_EIP712_TYPES,
} from "@parley/shared";
import { sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";

const SESSION_LIFETIME_SECONDS = 24 * 3600;

function ConnectInner() {
  const params = useSearchParams();
  const tid = params.get("tid") ?? params.get("telegram_user_id");

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, error: connectErr, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signTypedDataAsync, isPending: signing } = useSignTypedData();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [done, setDone] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  async function bindAndReturn() {
    if (!address || !tid) return;
    setSignError(null);
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS;
    try {
      // The typed-data domain pins chainId to Sepolia; some wallets reject
      // the sign request if their active chain doesn't match. Switch first.
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }
      const sig = await signTypedDataAsync({
        domain: PARLEY_EIP712_DOMAIN,
        types: SESSION_BINDING_EIP712_TYPES,
        primaryType: "SessionBinding",
        message: {
          telegram_user_id: BigInt(tid),
          wallet: address,
          expires_at: BigInt(expiresAt),
        },
      });
      sendResult({ kind: "session_bound", wallet: address, sig, expires_at: expiresAt });
      setDone(true);
    } catch (err) {
      setSignError((err as Error).message);
    }
  }

  if (!tid) {
    return (
      <Page>
        <h1>Connect wallet</h1>
        <p style={{ color: "crimson" }}>
          No <code>tid</code> param. Open this page from the Parley bot.
        </p>
      </Page>
    );
  }

  if (done) {
    return (
      <Page>
        <h1>Connected ✓</h1>
        <p>Session bound. You can return to Telegram.</p>
      </Page>
    );
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Connect wallet</h1>
        <p style={{ opacity: 0.7 }}>For Telegram user <code>{tid}</code></p>
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
        <p style={{ fontSize: 12, opacity: 0.6, marginTop: 16 }}>
          Inside Telegram, only WalletConnect routes to your phone wallet — extension
          buttons are listed but won't reach a browser-extension wallet from here.
          Open this URL in a regular browser tab to use MetaMask / Rabby / Coinbase
          Wallet directly.
        </p>
        {connectErr && <ErrLine>{connectErr.message}</ErrLine>}
      </Page>
    );
  }

  return (
    <Page>
      <h1>Sign session binding</h1>
      <p style={{ wordBreak: "break-all" }}>Wallet: {address}</p>
      <p>Chain: {chainId}</p>
      <p>Telegram user: {tid}</p>
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        This signature binds your wallet to your Telegram session for 24 hours. It
        is not a transaction; nothing is sent on-chain.
      </p>
      <button onClick={bindAndReturn} disabled={signing || switching} style={btn}>
        {switching ? "Switching to Sepolia…" : signing ? "Signing…" : "Sign session binding"}
      </button>
      <button
        onClick={() => disconnect()}
        style={{ ...btn, marginLeft: 12, background: "#eee", color: "#333" }}
      >
        Disconnect
      </button>
      {signError && <ErrLine>{signError}</ErrLine>}
    </Page>
  );
}

export default function ConnectFlow() {
  return (
    <Suspense fallback={<Page><p>Loading…</p></Page>}>
      <ConnectInner />
    </Suspense>
  );
}

// ---- helpers ---------------------------------------------------------------

interface ConnectorLike {
  type?: string;
  name?: string;
}
function connectorLabel(c: ConnectorLike): string {
  // Prefer the connector's own name (which is what wagmi reports — often the
  // detected wallet, like "MetaMask" / "Rabby"). Fall back to type.
  if (c.name && c.name.trim() !== "") return c.name;
  if (c.type === "walletConnect") return "WalletConnect (QR)";
  if (c.type === "injected") return "Browser extension";
  if (c.type === "coinbaseWallet") return "Coinbase Wallet";
  return c.type ?? "Wallet";
}

// ---- styling helpers ------------------------------------------------------

const btn: React.CSSProperties = {
  padding: "12px 20px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  background: "#0066ff",
  color: "white",
  cursor: "pointer",
};

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}>
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "crimson", marginTop: 12 }}>{children}</p>;
}
