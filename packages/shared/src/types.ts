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
  price: string; // base/quote, decimal string
  amount: string; // What the MM commits to fill
  expiry: number; // Unix seconds
  settlement_window_ms: number;
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
  | Accept
  | Reject
  | DealUserLocked
  | DealMmLocked;

// ---- On-chain Deal struct (§5.2 / §6.1) -------------------------------------

export interface DealTerms {
  user: Hex;
  mm: Hex;
  token_a: Hex; // user → mm
  token_b: Hex; // mm → user
  amount_a: string; // wei
  amount_b: string; // wei
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
