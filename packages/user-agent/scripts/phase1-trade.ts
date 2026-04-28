// =============================================================================
// PHASE 1 ONLY — REMOVE IN PHASE 2.
//
// Hardcoded user-side trade flow. Talks directly to AXL (no Hermes), submits
// chain transactions with USER_EVM_PRIVATE_KEY directly (no Mini App, no
// WalletConnect). Purpose: prove the architectural spine — Settlement.sol +
// AXL transport + EIP-712 + viem submission — before layering on the
// user-facing surface.
//
// Steps:
//   1. Boot AXL (verify own pubkey from /topology) and viem clients
//   2. Optionally self-mint mUSDC if balance is below `tradeAmount`
//   3. Approve Settlement to spend mUSDC if allowance is insufficient
//   4. Build hardcoded intent (sell USDC for WETH); sign; broadcast to MM
//   5. Poll /recv until an offer.quote arrives
//   6. Verify offer.deal hashes correctly + MM's sig is valid
//   7. Sign deal (EIP-712), submit lockUserSide(deal, userSig) on chain
//   8. Send Accept message to MM (so it knows to lock its side)
//   9. Wait for chain state to advance to BothLocked (MM locked)
//  10. Submit settle(dealHash) on chain
//  11. Verify Settled event + log final balances
//
// Run: pnpm -F @parley/user-agent phase1:trade
// =============================================================================

import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import type { Accept, Intent, Offer, ParleyMessage } from "@parley/shared";

import { AxlClient } from "../lib/axl-client.js";
import { dealForSigning, dealHash, DEAL_TYPES } from "../lib/eip712.js";

// ---- Config ----------------------------------------------------------------

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`env var ${name} is required`);
  return v;
};

const env = {
  rpcUrl: required("SEPOLIA_RPC_URL"),
  settlementContract: required("SETTLEMENT_CONTRACT_ADDRESS") as Hex,
  privateKey: required("USER_EVM_PRIVATE_KEY") as Hex,
  axlHttpUrl: process.env["USER_AXL_HTTP_URL"] ?? "http://localhost:9002",
  /** Comma-separated list of MM AXL pubkeys to broadcast to. Phase 1 demo
   *  has just one. ENS resolution lands in Phase 3. */
  knownMmAxlPubkeys: required("KNOWN_MM_AXL_PUBKEYS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  usdcAddr: (process.env["SEPOLIA_USDC_ADDRESS"] ??
    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238") as Hex,
  wethAddr: (process.env["SEPOLIA_WETH_ADDRESS"] ??
    "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14") as Hex,
};

const CHAIN_ID = 11155111;

// Mirror of Settlement.sol's DealState enum, used for getState() polling.
const STATE_NONE = 0;
const STATE_USER_LOCKED = 1;
const STATE_BOTH_LOCKED = 2;
const STATE_SETTLED = 3;
void STATE_NONE;
void STATE_USER_LOCKED;

// Hardcoded trade: user sells 50 mUSDC for mWETH.
const TRADE_AMOUNT_USDC_HUMAN = "50";
const TRADE_AMOUNT_USDC_WEI = 50n * 10n ** 6n; // 6 dp
const POLL_INTERVAL_MS = 2_000;
const OFFER_WAIT_TIMEOUT_MS = 60_000;
const SETTLE_WAIT_TIMEOUT_MS = 5 * 60_000;

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const SETTLEMENT_ABI = parseAbi([
  "function getState(bytes32 dealHash) view returns (uint8)",
  "function lockUserSide((address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce) deal, bytes userSig)",
  "function settle(bytes32 dealHash)",
]);

// ---- Boot ------------------------------------------------------------------

const account = privateKeyToAccount(env.privateKey);
const transport = http(env.rpcUrl);
const publicClient: PublicClient = createPublicClient({ chain: sepolia, transport });
const walletClient: WalletClient = createWalletClient({
  chain: sepolia,
  transport,
  account,
});
const axl = new AxlClient(env.axlHttpUrl);

const topo = await axl.topology();
log({
  event: "boot",
  user_address: account.address,
  axl_url: env.axlHttpUrl,
  axl_pubkey: topo.ourPublicKey,
  axl_peers: topo.peers.length,
  settlement: env.settlementContract,
  mm_targets: env.knownMmAxlPubkeys,
});

// ---- 1. Funding / approval -------------------------------------------------

await ensureBalanceAndApproval();

// ---- 2. Build + broadcast intent -------------------------------------------

const intent: Intent = {
  type: "intent.broadcast",
  id: randomUUID(),
  agent_id: account.address,
  from_axl_pubkey: topo.ourPublicKey,
  timestamp: Date.now(),
  side: "sell",
  base: { chain_id: CHAIN_ID, address: env.usdcAddr, symbol: "USDC", decimals: 6 },
  quote: { chain_id: CHAIN_ID, address: env.wethAddr, symbol: "WETH", decimals: 18 },
  amount: TRADE_AMOUNT_USDC_HUMAN,
  max_slippage_bps: 50,
  privacy: "public",
  min_counterparty_rep: 0,
  timeout_ms: 60_000,
  signature: "0x", // Phase 1: app-level sig left empty; on-chain EIP-712 sigs are what matter.
};

for (const peer of env.knownMmAxlPubkeys) {
  await axl.send(peer, JSON.stringify(intent));
  log({ event: "intent_broadcast", to: peer, intent_id: intent.id });
}

// ---- 3. Wait for first offer -----------------------------------------------

const offer = await waitForOffer(intent.id, OFFER_WAIT_TIMEOUT_MS);
log({
  event: "offer_received",
  offer_id: offer.id,
  mm: offer.mm_agent_id,
  price: offer.price,
  expiry: offer.expiry,
});

// ---- 4. Verify the offer's deal hash + MM sig ------------------------------

const expectedHash = dealHash(
  dealForSigning(offer.deal),
  env.settlementContract,
  CHAIN_ID,
);
const recoveredMm = await publicClient.verifyTypedData({
  address: offer.deal.mm,
  domain: {
    name: "Parley",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: env.settlementContract,
  },
  types: DEAL_TYPES,
  primaryType: "Deal",
  // viem expects an open record for the message; DealEip712 is structurally
  // compatible at runtime.
  message: dealForSigning(offer.deal) as unknown as Record<string, unknown>,
  signature: offer.signature,
});
if (!recoveredMm) {
  throw new Error("MM signature failed verification — offer rejected");
}
if (offer.deal.user.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`offer.deal.user mismatch: ${offer.deal.user} vs ${account.address}`);
}
log({ event: "offer_verified", deal_hash: expectedHash });

// ---- 5. Sign Deal + submit lockUserSide ------------------------------------

const userSig = await account.signTypedData({
  domain: {
    name: "Parley",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: env.settlementContract,
  },
  types: DEAL_TYPES,
  primaryType: "Deal",
  message: dealForSigning(offer.deal),
});

const lockTxHash = await walletClient.sendTransaction({
  account,
  chain: sepolia,
  to: env.settlementContract,
  data: encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: "lockUserSide",
    args: [
      {
        user: offer.deal.user,
        mm: offer.deal.mm,
        tokenA: offer.deal.tokenA,
        tokenB: offer.deal.tokenB,
        amountA: BigInt(offer.deal.amountA),
        amountB: BigInt(offer.deal.amountB),
        deadline: BigInt(offer.deal.deadline),
        nonce: BigInt(offer.deal.nonce),
      },
      userSig,
    ],
  }),
});
await publicClient.waitForTransactionReceipt({ hash: lockTxHash, confirmations: 1 });
log({ event: "user_locked", deal_hash: expectedHash, tx: lockTxHash });

// ---- 6. Send Accept so MM knows to lock ------------------------------------

const accept: Accept = {
  type: "offer.accept",
  id: randomUUID(),
  offer_id: offer.id,
  user_agent_id: account.address,
  deal_hash: expectedHash,
  signature: userSig,
};
// X-From-Peer-Id from earlier offer recv = MM's prefix-padded form. We have
// the MM's full pubkey in env, use that to be safe.
for (const peer of env.knownMmAxlPubkeys) {
  await axl.send(peer, JSON.stringify(accept));
}
log({ event: "accept_sent", offer_id: offer.id });

// ---- 7. Wait for MM to lockMMSide ------------------------------------------

await waitForState(expectedHash, [STATE_BOTH_LOCKED, STATE_SETTLED], SETTLE_WAIT_TIMEOUT_MS);
log({ event: "mm_locked_observed", deal_hash: expectedHash });

// ---- 8. Submit settle ------------------------------------------------------

const stateNow = await getState(expectedHash);
if (stateNow !== STATE_SETTLED) {
  const settleTxHash = await walletClient.sendTransaction({
    account,
    chain: sepolia,
    to: env.settlementContract,
    data: encodeFunctionData({
      abi: SETTLEMENT_ABI,
      functionName: "settle",
      args: [expectedHash],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: settleTxHash, confirmations: 1 });
  log({ event: "settle_submitted", tx: settleTxHash });
}

// ---- 9. Final balances + state check ---------------------------------------

const [usdcBal, wethBal, finalState] = await Promise.all([
  publicClient.readContract({ address: env.usdcAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  publicClient.readContract({ address: env.wethAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
  getState(expectedHash),
]);
log({
  event: "settled",
  deal_hash: expectedHash,
  final_state: finalState,
  user_usdc_wei: usdcBal.toString(),
  user_weth_wei: wethBal.toString(),
});

if (finalState !== STATE_SETTLED) {
  throw new Error(`expected state SETTLED (3), got ${finalState}`);
}
log({ event: "phase1_demo_complete" });

// ============================================================================
// Helpers
// ============================================================================

async function ensureBalanceAndApproval(): Promise<void> {
  const balance = await publicClient.readContract({
    address: env.usdcAddr,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (balance < TRADE_AMOUNT_USDC_WEI) {
    log({
      event: "self_minting",
      token: env.usdcAddr,
      amount: TRADE_AMOUNT_USDC_WEI.toString(),
      reason_balance: balance.toString(),
    });
    const txHash = await walletClient.sendTransaction({
      account,
      chain: sepolia,
      to: env.usdcAddr,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "mint",
        args: [account.address, TRADE_AMOUNT_USDC_WEI * 10n], // 10x headroom
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  }

  const allowance = await publicClient.readContract({
    address: env.usdcAddr,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, env.settlementContract],
  });
  if (allowance < TRADE_AMOUNT_USDC_WEI) {
    log({ event: "approving", spender: env.settlementContract });
    const txHash = await walletClient.sendTransaction({
      account,
      chain: sepolia,
      to: env.usdcAddr,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [env.settlementContract, 2n ** 256n - 1n], // unlimited; cap-and-reapprove is Phase 4 polish
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  }
}

async function waitForOffer(intentId: string, timeoutMs: number): Promise<Offer> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const inbox = await axl.recv();
    if (!inbox) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const msg = parseMessage(inbox.body);
    if (msg && msg.type === "offer.quote" && msg.intent_id === intentId) {
      return msg;
    }
    log({ event: "ignored", type: msg?.type ?? "unparsable" });
  }
  throw new Error(`no offer for intent ${intentId} within ${timeoutMs}ms`);
}

async function waitForState(
  dealHashHex: Hex,
  desired: number[],
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await getState(dealHashHex);
    if (desired.includes(s)) return;
    if (s === STATE_NONE) {
      // Means our lockUserSide hasn't been mined yet, or refund happened.
      // either way, keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `state did not reach ${desired.join("/")} within ${timeoutMs}ms (last=${await getState(dealHashHex)})`,
  );
}

async function getState(dealHashHex: Hex): Promise<number> {
  return Number(
    await publicClient.readContract({
      address: env.settlementContract,
      abi: SETTLEMENT_ABI,
      functionName: "getState",
      args: [dealHashHex],
    }),
  );
}

function parseMessage(body: Buffer): ParleyMessage | null {
  try {
    const j = JSON.parse(body.toString("utf-8")) as ParleyMessage;
    if (typeof j !== "object" || j === null || typeof j.type !== "string") return null;
    return j;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}
