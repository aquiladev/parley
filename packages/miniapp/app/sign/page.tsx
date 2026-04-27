// /sign — accepted-offer flow (SPEC §10.2 "two-step lock case").
// IMPORTANT: this single Mini App session must complete BOTH steps before closing:
// 1. signTypedData(Deal) → userSig
// 2. writeContract({ functionName: "lockUserSide", args: [deal, userSig] })
// 3. sendData({ kind: "lock_submitted", txHash, dealId }) and close

export default function SignFlow() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Sign and lock</h1>
      <p>TODO: signTypedData(Deal) → writeContract(lockUserSide).</p>
    </main>
  );
}
