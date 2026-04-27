export default function Index() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Parley Mini App</h1>
      <p>
        This page should not be reached directly. Routes are dispatched by the
        bot via deep-linked URLs:
      </p>
      <ul>
        <li>
          <code>/connect</code> — wallet connect + session-binding signature
        </li>
        <li>
          <code>/sign</code> — sign Deal + submit lockUserSide
        </li>
        <li>
          <code>/settle</code> — submit settle(dealHash)
        </li>
        <li>
          <code>/refund</code> — submit refund(dealHash) after deadline
        </li>
        <li>
          <code>/swap</code> — Uniswap fallback swap
        </li>
        <li>
          <code>/register</code> — opt-in *.parley.eth subname mint
        </li>
      </ul>
    </main>
  );
}
