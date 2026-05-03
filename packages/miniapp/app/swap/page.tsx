// /swap — Uniswap fallback (SPEC §9.1).
// 1. If approval_token + approval_spender are present in the URL, send an
//    ERC-20 approve(spender, max) tx first (Permit2 typically; the Trading
//    API tells us which spender).
// 2. Then sendTransaction({ to, data, value }) — calldata supplied by the
//    User Agent via og-mcp.prepare_fallback_swap.
//
// URL: /swap?to=<addr>&data=<hex>&value=<wei>&approval_token=<addr>&approval_spender=<addr>
//             &expected_input=<decimal>&expected_output=<decimal>&pair=<USDC/WETH>
//
// `expected_*` and `pair` are display-only; we never trust them for tx
// construction (calldata already encodes the swap).

"use client";

import { Suspense, useEffect, useState } from "react";
import {
  useAccount,
  useConnect,
  useSwitchChain,
  useWriteContract,
  useSendTransaction,
  usePublicClient,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import { parseAbi, type Hex } from "viem";
import { sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";
import { MiniAppHeader } from "../../lib/header";
import { formatTxError } from "../../lib/tx-error";
import {
  estimateContractOverrides,
  estimateSendOverrides,
} from "../../lib/gas-estimator";

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const MAX_UINT256 = (1n << 256n) - 1n;

// We approve MAX_UINT256 on the first swap; on every subsequent swap the
// remaining allowance is still astronomically large (any realistic single
// swap consumes < 1e25 wei). If the on-chain allowance exceeds this
// threshold, we know a prior max-approve is in place and the user
// shouldn't have to re-approve. Threshold 2^200 ≈ 1.6e60.
const PRIOR_MAX_APPROVE_THRESHOLD = 1n << 200n;

type Step = "idle" | "approving" | "swapping" | "confirming" | "done";

function SwapInner() {
  const params = useSearchParams();
  const to = params.get("to") as Hex | null;
  const data = params.get("data") as Hex | null;
  const valueStr = params.get("value");
  const approvalToken = params.get("approval_token") as Hex | null;
  const approvalSpender = params.get("approval_spender") as Hex | null;
  const expectedInput = params.get("expected_input");
  const expectedOutput = params.get("expected_output");
  const pair = params.get("pair");
  const expectedWallet = params.get("wallet") as Hex | null;

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  const [step, setStep] = useState<Step>("idle");
  const [approvalTx, setApprovalTx] = useState<Hex | null>(null);
  const [swapTx, setSwapTx] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

  const malformed =
    !to ||
    !data ||
    !/^0x[0-9a-fA-F]{40}$/.test(to) ||
    !/^0x[0-9a-fA-F]+$/.test(data);

  if (malformed) {
    return (
      <Page>
        <h1>Uniswap fallback swap</h1>
        <ErrLine>
          Missing or malformed swap calldata. The bot must rebuild the link.
        </ErrLine>
      </Page>
    );
  }

  const value = (() => {
    try {
      return BigInt(valueStr ?? "0");
    } catch {
      return 0n;
    }
  })();

  // URL says approval is needed (token + spender provided). Whether an
  // approve TX is ACTUALLY needed depends on the on-chain allowance —
  // see the useEffect below that checks it and sets needsApproveTx.
  const approvalConfigured = Boolean(
    approvalToken &&
      approvalSpender &&
      /^0x[0-9a-fA-F]{40}$/.test(approvalToken) &&
      /^0x[0-9a-fA-F]{40}$/.test(approvalSpender),
  );
  // null until we've read on-chain allowance once.
  const [needsApproveTx, setNeedsApproveTx] = useState<boolean | null>(null);

  // Read current allowance once the wallet is connected. If a prior
  // max-approve is already in place, skip the approve tx — saves a
  // confirmation, eliminates the "why is it asking again?" friction.
  useEffect(() => {
    if (!approvalConfigured || !publicClient || !address || !approvalToken || !approvalSpender) {
      setNeedsApproveTx(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const allowance = (await publicClient.readContract({
          address: approvalToken,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, approvalSpender],
        })) as bigint;
        if (cancelled) return;
        setNeedsApproveTx(allowance < PRIOR_MAX_APPROVE_THRESHOLD);
      } catch {
        // RPC blip or unsupported. Default to safe (require approve).
        if (!cancelled) setNeedsApproveTx(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [approvalConfigured, publicClient, address, approvalToken, approvalSpender]);

  async function submit() {
    if (!to || !data) return;
    setError(null);
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }

      if (needsApproveTx && approvalToken && approvalSpender) {
        setStep("approving");
        // Pre-fill gas params (see lib/gas-estimator.ts).
        const approveOverrides = publicClient && address
          ? await estimateContractOverrides(publicClient, {
              address: approvalToken,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [approvalSpender, MAX_UINT256],
              account: address,
            })
          : undefined;
        const aHash = await writeContractAsync({
          address: approvalToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [approvalSpender, MAX_UINT256],
          ...(approveOverrides ?? {}),
        });
        setApprovalTx(aHash);
        if (publicClient) {
          await publicClient.waitForTransactionReceipt({
            hash: aHash,
            confirmations: 1,
          });
        }
      }

      setStep("swapping");
      // Pre-fill gas params for the raw sendTransaction. estimateGas may
      // revert here if the calldata wouldn't succeed (e.g., approval not
      // settled yet, slippage breached) — that's a useful pre-flight.
      const swapOverrides = publicClient && address
        ? await estimateSendOverrides(publicClient, {
            account: address,
            to,
            data,
            value,
          })
        : undefined;
      const sHash = await sendTransactionAsync({
        to,
        data,
        value,
        ...(swapOverrides ?? {}),
      });
      setSwapTx(sHash);
      setStep("confirming");
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({
          hash: sHash,
          confirmations: 1,
        });
      }
      setStep("done");
      sendResult({ kind: "swapped", txHash: sHash });
    } catch (err) {
      setError(formatTxError(err));
      setStep("idle");
    }
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Uniswap fallback swap</h1>
        <p style={{ color: "var(--parley-hint)" }}>
          {expectedWallet
            ? <>Connect wallet <code>{shortAddr(expectedWallet)}</code> to fall back to Uniswap.</>
            : "Connect your wallet to fall back to Uniswap."}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {connectors.map((c) => (
            <button
              key={c.uid}
              onClick={() => connect({ connector: c })}
              disabled={connecting}
              style={btn}
            >
              {connecting ? "Connecting…" : `Connect via ${connectorLabel(c)}`}
            </button>
          ))}
        </div>
      </Page>
    );
  }

  // Soft warning. /swap calldata's `recipient` is set when the agent built it
  // (typically the bound wallet). Submitting from a different wallet means
  // YOU pay gas but the tokens may end up at the agent-baked recipient, not
  // your current wallet — depends on the calldata. Tell the user.
  const walletMismatch =
    expectedWallet &&
    address &&
    expectedWallet.toLowerCase() !== address.toLowerCase();

  return (
    <Page>
      <h1>Uniswap fallback swap</h1>
      <p style={{ fontSize: 13, color: "var(--parley-hint)", lineHeight: 1.5 }}>
        No peer offer matched in time. Submit this swap on Uniswap from your
        own wallet — same tokens, current Uniswap rate. You pay gas.
      </p>

      {(expectedInput || expectedOutput || pair) && (
        <div
          style={{
            margin: "12px 0",
            padding: "10px 12px",
            background: "var(--parley-secondary-bg)",
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          {pair && <div style={{ fontWeight: 600 }}>{pair}</div>}
          {expectedInput && expectedOutput && (
            <div style={{ marginTop: 4 }}>
              {expectedInput} → ~{expectedOutput}
            </div>
          )}
        </div>
      )}

      {walletMismatch && (
        <div style={softNotice}>
          <b>Heads up:</b> the bot built this swap for{" "}
          <code>{shortAddr(expectedWallet!)}</code>; you've connected{" "}
          <code>{shortAddr(address!)}</code>. You can still submit, but the
          calldata may route the output back to the original wallet — verify
          the wallet's transaction prompt before signing.
        </div>
      )}

      {approvalConfigured && needsApproveTx === true && (
        <p style={{ fontSize: 13, color: "var(--parley-hint)" }}>
          An ERC-20 approval is required first (one-time, max-allowance).
          Two transactions total.
        </p>
      )}
      {approvalConfigured && needsApproveTx === false && (
        <p style={{ fontSize: 13, color: "var(--parley-hint)" }}>
          Token already approved — single transaction.
        </p>
      )}

      <button onClick={submit} disabled={step !== "idle" || (approvalConfigured && needsApproveTx === null)} style={btn}>
        {step === "approving"
          ? "Approving token…"
          : step === "swapping"
            ? "Submitting swap…"
            : step === "confirming"
              ? "Waiting for confirmation…"
              : step === "done"
                ? "Done ✓"
                : approvalConfigured && needsApproveTx === null
                  ? "Checking allowance…"
                  : needsApproveTx
                    ? "Approve and swap"
                    : "Submit swap"}
      </button>

      {approvalTx && (
        <p style={{ marginTop: 12, fontSize: 13 }}>
          approve tx:{" "}
          <a
            href={`https://sepolia.etherscan.io/tx/${approvalTx}`}
            target="_blank"
            rel="noreferrer"
          >
            {short(approvalTx)}
          </a>
        </p>
      )}
      {swapTx && (
        <p style={{ marginTop: 4, fontSize: 13 }}>
          swap tx:{" "}
          <a
            href={`https://sepolia.etherscan.io/tx/${swapTx}`}
            target="_blank"
            rel="noreferrer"
          >
            {short(swapTx)}
          </a>
        </p>
      )}
      {error && <ErrLine>{error}</ErrLine>}
    </Page>
  );
}

export default function Swap() {
  return (
    <Suspense
      fallback={
        <Page>
          <p>Loading…</p>
        </Page>
      }
    >
      <SwapInner />
    </Suspense>
  );
}

// ---- helpers --------------------------------------------------------------

interface ConnectorLike {
  type?: string;
  name?: string;
}
function connectorLabel(c: ConnectorLike): string {
  if (c.name && c.name.trim() !== "") return c.name;
  if (c.type === "walletConnect") return "WalletConnect (QR)";
  if (c.type === "injected") return "Browser extension";
  if (c.type === "coinbaseWallet") return "Coinbase Wallet";
  return c.type ?? "Wallet";
}

function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const softNotice: React.CSSProperties = {
  background: "var(--parley-secondary-bg)",
  borderRadius: 8,
  padding: "10px 12px",
  margin: "12px 0",
  fontSize: 13,
  lineHeight: 1.5,
};

const btn: React.CSSProperties = {
  background: "var(--parley-btn-bg)",
  color: "var(--parley-btn-fg)",
  padding: "12px 20px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  cursor: "pointer",
};

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}
    >
      <MiniAppHeader />
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: "var(--parley-error)", marginTop: 12, wordBreak: "break-word" }}>
      {children}
    </p>
  );
}
