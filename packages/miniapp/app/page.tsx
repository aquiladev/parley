export default function Index() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
      <img
        src="/lockup-horizontal.svg"
        alt="Parley"
        width={220}
        height={44}
        style={{ display: "block", marginBottom: 16 }}
      />
      <p>
        This page should not be reached directly. Routes are dispatched by the
        bot via deep-linked URLs:
      </p>
      <ul>
        <li>
          <code>/connect</code> — wallet connect + session-binding signature
        </li>
        <li>
          <code>/authorize-intent</code> — sign IntentAuthorization for broadcast
        </li>
        <li>
          <code>/sign</code> — sign Deal + AcceptAuthorization, submit lockUserSide
        </li>
        <li>
          <code>/settle</code> — submit settle(dealHash)
        </li>
        <li>
          <code>/refund</code> — submit refund(dealHash) after deadline (Phase 4)
        </li>
        <li>
          <code>/swap</code> — Uniswap fallback swap (Phase 5)
        </li>
        <li>
          <code>/register</code> — opt-in *.parley.eth subname mint (Phase 5)
        </li>
      </ul>
    </main>
  );
}
