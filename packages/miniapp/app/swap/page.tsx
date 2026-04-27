// /swap — Uniswap fallback (SPEC §9).
// 1. If approvalRequired: submit Permit2 approval first.
// 2. sendTransaction({ to, data, value }) — calldata supplied by the User Agent
//    via the Trading API's /swap endpoint.

export default function SwapFlow() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Uniswap fallback swap</h1>
      <p>TODO: optional Permit2 approval → sendTransaction(swap calldata).</p>
    </main>
  );
}
