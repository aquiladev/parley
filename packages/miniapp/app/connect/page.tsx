// /connect — first-message onboarding (SPEC §4.5.1, §10.2).
// 1. WalletConnect modal → user connects their wallet
// 2. User signs session-binding EIP-712 (24h expiry)
// 3. sendData({ kind: "session_bound", wallet, sig, expires_at }) and close

export default function ConnectFlow() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Connect wallet</h1>
      <p>TODO: WalletConnect + session-binding EIP-712 signature.</p>
    </main>
  );
}
