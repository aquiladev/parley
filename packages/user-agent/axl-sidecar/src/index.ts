// AXL sidecar — see SPEC.md §4.1.
// Polls AXL `GET /recv` and watches the Settlement contract for
// UserLocked / MMLocked / Settled / Refunded events. Bridges both
// streams into Hermes' inbox so the User Agent can react asynchronously.

const AXL_HTTP_URL = process.env["AXL_HTTP_URL"] ?? "http://localhost:9002";

async function pollOnce(): Promise<void> {
  // TODO: drain GET /recv until 204, forward each message into Hermes' inbox.
  void AXL_HTTP_URL;
}

async function main(): Promise<void> {
  // TODO: wire chain-watcher (viem.watchContractEvent) for Settlement events.
  // TODO: schedule pollOnce() at ~2s cadence during active negotiations.
  await pollOnce();
  console.log("[axl-sidecar] skeleton — not yet implemented");
}

main().catch((err) => {
  console.error("[axl-sidecar] fatal:", err);
  process.exit(1);
});
