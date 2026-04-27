// og-mcp — MCP server for 0G Storage reads/writes + ENS resolution.
// SPEC §4.3, §4.4, §7.
//
// Tools:
//   - resolve_mm(ens_name)
//   - read_mm_reputation(ens_name)
//   - read_user_reputation(wallet_address)
//   - read_trade_history(participant, limit)
//   - write_trade_record(telegram_user_id, record, session_sig)            [PRIVILEGED]
//   - update_mm_reputation_root(ens_name, new_root)                        (MM-side)

async function main(): Promise<void> {
  // TODO: stand up MCP HTTP server, init Indexer client, ENS resolver via viem.
  console.log("[og-mcp] skeleton — not yet implemented");
}

main().catch((err) => {
  console.error("[og-mcp] fatal:", err);
  process.exit(1);
});
