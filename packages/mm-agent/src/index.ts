// MM Agent entry — deterministic state machine, no LLM in the pricing path.
// SPEC §4.2.
//
//   LISTENING → INTENT_RECEIVED → PRICING → QUOTE_SENT
//             → AWAITING_ACCEPT → SETTLING → COMPLETE → LISTENING

async function main(): Promise<void> {
  // TODO:
  //   1. Boot AXL listener (poll GET /recv)
  //   2. For each intent.broadcast: filter on inventory + capabilities
  //   3. Price via pricing.ts (Uniswap TWAP + spread)
  //   4. Sign offer via negotiator.ts; POST /send to originator
  //   5. On accept: lockMMSide from hot wallet via viem.writeContract
  //   6. Watch for Settled event; write TradeRecord to 0G Storage
  console.log("[mm-agent] skeleton — not yet implemented");
}

main().catch((err) => {
  console.error("[mm-agent] fatal:", err);
  process.exit(1);
});
