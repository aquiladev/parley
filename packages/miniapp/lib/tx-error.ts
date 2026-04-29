// Friendly transaction-error formatting. wagmi/viem surface a wide variety
// of error shapes (User rejection, RPC timeout, on-chain revert, allowance
// problem). Surfacing the raw `.message` is bad UX — RPC errors carry
// stack-trace-flavored noise; user-rejection messages bury the simple fact.
//
// This helper inspects known patterns and returns a short, human-readable
// summary suitable for the Mini App's red error line.

interface ErrLike {
  name?: string;
  shortMessage?: string;
  message?: string;
  details?: string;
  cause?: ErrLike;
}

export function formatTxError(err: unknown): string {
  const e = err as ErrLike;
  const parts = [e?.name, e?.shortMessage, e?.message, e?.details, e?.cause?.message]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .join(" | ")
    .toLowerCase();

  // 1. User rejected (the most common, deserves the cleanest message).
  if (
    parts.includes("user rejected") ||
    parts.includes("user denied") ||
    parts.includes("rejected the request") ||
    e?.name === "UserRejectedRequestError"
  ) {
    return "You rejected the request in your wallet.";
  }

  // 2. Allowance / approval issues.
  if (
    parts.includes("erc20: insufficient allowance") ||
    parts.includes("transfer amount exceeds allowance") ||
    parts.includes("erc20insufficientallowance")
  ) {
    return "Token allowance is too low. Approve the contract and try again.";
  }

  // 3. Insufficient balance for gas or transfer.
  if (
    parts.includes("insufficient funds") ||
    parts.includes("insufficient balance") ||
    parts.includes("exceeds balance")
  ) {
    return "Insufficient balance to cover gas or the transfer amount.";
  }

  // 4. Wrong network.
  if (
    parts.includes("chain mismatch") ||
    parts.includes("unsupported chain") ||
    parts.includes("chainid should be same") ||
    parts.includes("switchchain")
  ) {
    return "Wrong network — switch your wallet to Sepolia.";
  }

  // 5. RPC connectivity.
  if (
    parts.includes("network request failed") ||
    parts.includes("fetch failed") ||
    parts.includes("timeout") ||
    parts.includes("econnrefused") ||
    parts.includes("rpc")
  ) {
    return "Network or RPC error. Try again in a moment.";
  }

  // 6. Generic on-chain revert.
  if (parts.includes("execution reverted") || parts.includes("contractfunctionexecutionerror")) {
    const reason = (e?.shortMessage ?? e?.message ?? "").trim();
    return reason.length > 0 && reason.length < 200
      ? reason
      : "Transaction reverted on-chain.";
  }

  // Fallback: shortMessage if present, else trimmed message.
  const fallback = (e?.shortMessage ?? e?.message ?? "Unknown error").trim();
  return fallback.length > 200 ? fallback.slice(0, 200) + "…" : fallback;
}
