// /connect — Phase 0 #8 verification surface.
// Future Phase 2 work adds the session-binding EIP-712 signature step
// (SPEC §4.5.1, §10.2). For now this is just enough to prove WalletConnect
// round-trips on iOS with mobile MetaMask.

"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export default function ConnectFlow() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, error, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const wc = connectors.find((c) => c.type === "walletConnect");

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5 }}>
      <h1>Connect wallet</h1>

      {isConnected ? (
        <div>
          <p>
            <strong>Connected.</strong>
          </p>
          <p style={{ wordBreak: "break-all" }}>Address: {address}</p>
          <p>Chain ID: {chainId}</p>
          <button
            onClick={() => disconnect()}
            style={{ padding: "8px 16px", marginTop: 12 }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div>
          <button
            onClick={() => wc && connect({ connector: wc })}
            disabled={!wc || isPending}
            style={{ padding: "12px 20px", fontSize: 16 }}
          >
            {isPending ? "Connecting…" : "Connect via WalletConnect"}
          </button>
          {!wc && (
            <p style={{ color: "crimson", marginTop: 12 }}>
              WalletConnect connector not initialized. Check that
              NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set in
              packages/miniapp/.env.local.
            </p>
          )}
          {error && (
            <p style={{ color: "crimson", marginTop: 12 }}>{error.message}</p>
          )}
        </div>
      )}

      <p style={{ marginTop: 24, fontSize: 12, opacity: 0.6 }}>
        Phase 0 #8 smoke test — open this URL on a phone, tap Connect, scan or
        approve in MetaMask Mobile, return here, see the address.
      </p>
    </main>
  );
}
