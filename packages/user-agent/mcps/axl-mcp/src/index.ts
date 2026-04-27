// axl-mcp — MCP server exposing AXL peer-network tools to Hermes.
// SPEC §4.3, §5.0.
//
// Tools (privileged ones run the §4.3 four-check validation contract):
//   - discover_peers()
//   - broadcast_intent(telegram_user_id, intent, intent_sig, session_sig)  [PRIVILEGED]
//   - send_offer(intent_id, offer)                                          (MM-side)
//   - send_accept(telegram_user_id, offer_id, accept_sig, session_sig)     [PRIVILEGED]
//   - poll_inbox()
//   - get_topology()

const AXL_HTTP_URL = process.env["AXL_HTTP_URL"] ?? "http://localhost:9002";

async function main(): Promise<void> {
  // TODO: stand up MCP HTTP server, register tools, wire validation contract.
  void AXL_HTTP_URL;
  console.log("[axl-mcp] skeleton — not yet implemented");
}

main().catch((err) => {
  console.error("[axl-mcp] fatal:", err);
  process.exit(1);
});
