// Shared types — see SPEC.md §5.2 (AXL message schemas) and §7.1 (TradeRecord).

export type Hex = `0x${string}`;

export interface TokenRef {
  chain_id: number; // 11155111 = Sepolia
  address: Hex;
  symbol: string;
  decimals: number;
}

// ---- AXL message envelopes (§5.1) -------------------------------------------

export interface Intent {
  type: "intent.broadcast";
  id: string; // UUID v4
  agent_id: Hex; // Wallet address of the user
  /** Sender's AXL ed25519 public key (full 64-hex). Required because AXL's
   *  X-From-Peer-Id header carries a prefix-padded routing form, not the
   *  raw key — see memory `axl_transport_quirks.md`. The MM Agent uses
   *  this value as X-Destination-Peer-Id when replying with an Offer. */
  from_axl_pubkey: string;
  timestamp: number;
  side: "buy" | "sell";
  base: TokenRef;
  quote: TokenRef;
  amount: string; // Decimal string; parseUnits later
  max_slippage_bps: number; // 50 = 0.5%
  privacy: "public"; // v1.0: public only
  min_counterparty_rep: number; // [-0.5, 1.0]
  timeout_ms: number;
  signature: Hex;
}

export interface Offer {
  type: "offer.quote";
  id: string;
  intent_id: string;
  mm_agent_id: Hex;
  /** MM's ENS subname (e.g. mm-1.parley.eth). Lets the User Agent display
   *  a meaningful identity in the offer card without doing reverse ENS
   *  resolution. The user's verifier should re-resolve this name and
   *  confirm `addr` matches `mm_agent_id` and `axl_pubkey` matches the AXL
   *  prefix-padded form of the sender's pubkey (SPEC §4.4 verification). */
  mm_ens_name: string;
  price: string; // base/quote, decimal string
  amount: string; // What the MM commits to fill
  expiry: number; // Unix seconds
  settlement_window_ms: number;
  /** Full on-chain deal terms — the user verifies + signs over this exact
   *  struct. Must match what the MM also signs (and what the contract's
   *  dealHash() will recompute). */
  deal: DealTerms;
  /** EIP-712 signature of `deal` by `mm_agent_id`. The MM submits this same
   *  sig on-chain via lockMMSide; the user just verifies it before accepting. */
  signature: Hex;
}

export interface Accept {
  type: "offer.accept";
  id: string;
  offer_id: string;
  user_agent_id: Hex;
  deal_hash: Hex;
  signature: Hex;
}

export interface Reject {
  type: "offer.reject";
  id: string;
  offer_id: string;
  reason?: string;
}

/**
 * Phase 8b: MM-side decline-to-quote signal. Sent over AXL when an MM
 * receives an Intent it cannot quote on (stale Uniswap reference cache,
 * unsupported pair, insufficient inventory). Lets the User Agent
 * short-circuit its offer-collection wait instead of timing out the
 * full `intent.timeout_ms` window.
 *
 * Intentionally unsigned — declines are advisory; a forged decline can
 * only shorten the User Agent's wait by one MM, never move funds. If
 * forgery becomes a real abuse vector we'd add an EIP-712 envelope
 * later, but for the demo the worst case is benign.
 *
 * `reason` is free-form; the User Agent doesn't surface it to end users
 * (operator-side debugging only via `make logs-prod`). Current MM-side
 * values: "price_unavailable" (Phase 8 cache stale / empty),
 * "unsupported_pair_or_insufficient_balance" (Phase 1 inventory check).
 */
export interface OfferDecline {
  type: "offer.decline";
  intent_id: string;
  mm_agent_id: Hex;
  mm_ens_name: string;
  reason: string;
  timestamp: string;
}

export interface DealUserLocked {
  type: "deal.user_locked";
  deal_hash: Hex;
  tx_hash: Hex;
}

export interface DealMmLocked {
  type: "deal.mm_locked";
  deal_hash: Hex;
  tx_hash: Hex;
}

export type ParleyMessage =
  | Intent
  | Offer
  | OfferDecline
  | Accept
  | Reject
  | DealUserLocked
  | DealMmLocked;

// ---- On-chain Deal struct (§5.2 / §6.1) -------------------------------------
// Field names MUST match the EIP-712 Deal typehash exactly (camelCase).
// Off-chain typed-data signing produces a digest the contract can recover
// only when these names align with the typehash string in Settlement.sol.

export interface DealTerms {
  user: Hex;
  mm: Hex;
  tokenA: Hex; // user → mm
  tokenB: Hex; // mm → user
  amountA: string; // wei (decimal string for JSON transport; bigint in code)
  amountB: string; // wei
  deadline: number; // Unix seconds
  nonce: string;
}

// ---- 0G Storage TradeRecord (§7.1) ------------------------------------------

export interface TradeRecord {
  trade_id: string; // == deal_hash
  timestamp: number;
  user_agent: Hex;
  mm_agent: Hex;
  pair: string; // e.g. "USDC/WETH"
  amount_a: string;
  amount_b: string;
  negotiated_price: string;

  user_locked: boolean;
  user_locked_at: number;
  mm_locked: boolean;
  mm_locked_at: number;
  settled: boolean;
  settlement_block: number | null;

  defaulted: "none" | "user" | "mm" | "timeout";

  user_signature: Hex;
  mm_signature: Hex | null;
}

// ---- EIP-712 domain (§6.4) --------------------------------------------------

export const PARLEY_EIP712_DOMAIN = {
  name: "Parley",
  version: "1",
  chainId: 11155111,
} as const;

export const DEAL_EIP712_TYPES = {
  Deal: [
    { name: "user", type: "address" },
    { name: "mm", type: "address" },
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "amountA", type: "uint256" },
    { name: "amountB", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

// ---- Privileged-tool auth (§4.3) --------------------------------------------
// Three off-chain EIP-712 signatures that gate privileged MCP tool calls.
//   - SessionBinding: signed once at `/connect`, valid 24h. Binds a Telegram
//                     user_id to a wallet address.
//   - IntentAuthorization: signed per `broadcast_intent` call.
//   - AcceptAuthorization: signed per `send_accept` call.
//
// Same domain as Deal so wallets render them with the same project name.

export const SESSION_BINDING_EIP712_TYPES = {
  SessionBinding: [
    { name: "telegram_user_id", type: "uint64" },
    { name: "wallet", type: "address" },
    { name: "expires_at", type: "uint64" },
  ],
} as const;

export const INTENT_AUTHORIZATION_EIP712_TYPES = {
  IntentAuthorization: [
    { name: "intent_id", type: "string" },
    { name: "telegram_user_id", type: "uint64" },
    { name: "issued_at", type: "uint64" },
  ],
} as const;

export const ACCEPT_AUTHORIZATION_EIP712_TYPES = {
  AcceptAuthorization: [
    { name: "offer_id", type: "string" },
    { name: "deal_hash", type: "bytes32" },
    { name: "telegram_user_id", type: "uint64" },
    { name: "issued_at", type: "uint64" },
  ],
} as const;

export interface SessionBinding {
  telegram_user_id: string; // bigint as decimal string for JSON transport
  wallet: Hex;
  expires_at: number; // Unix seconds
}

export interface IntentAuthorization {
  intent_id: string;
  telegram_user_id: string;
  issued_at: number;
}

export interface AcceptAuthorization {
  offer_id: string;
  deal_hash: Hex;
  telegram_user_id: string;
  issued_at: number;
}
