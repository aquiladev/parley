// /register — opt-in user ENS subname mint (SPEC §4.5.3).
// Triggered by /register <handle>. Registration is NEVER required to trade.

export default function RegisterFlow() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Register *.parley.eth handle</h1>
      <p>TODO: validate availability → submit subname mint tx.</p>
    </main>
  );
}
