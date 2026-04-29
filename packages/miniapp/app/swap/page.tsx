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

import { Suspense, useState } from "react";
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

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const MAX_UINT256 = (1n << 256n) - 1n;

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

  const { isConnected, chainId } = useAccount();
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

  const needsApproval = Boolean(
    approvalToken &&
      approvalSpender &&
      /^0x[0-9a-fA-F]{40}$/.test(approvalToken) &&
      /^0x[0-9a-fA-F]{40}$/.test(approvalSpender),
  );

  async function submit() {
    if (!to || !data) return;
    setError(null);
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }

      if (needsApproval && approvalToken && approvalSpender) {
        setStep("approving");
        const aHash = await writeContractAsync({
          address: approvalToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [approvalSpender, MAX_UINT256],
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
      const sHash = await sendTransactionAsync({
        to,
        data,
        value,
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
        <p style={{ opacity: 0.7 }}>
          Connect your wallet to fall back to Uniswap.
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

  return (
    <Page>
      <h1>Uniswap fallback swap</h1>
      <p style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5 }}>
        No peer offer matched in time. Submit this swap on Uniswap from your
        own wallet — same tokens, current Uniswap rate. You pay gas.
      </p>

      {(expectedInput || expectedOutput || pair) && (
        <div
          style={{
            margin: "12px 0",
            padding: "10px 12px",
            background: "rgba(0,0,0,0.04)",
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

      {needsApproval && (
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          A Permit2 approval is required first. Two transactions total.
        </p>
      )}

      <button onClick={submit} disabled={step !== "idle"} style={btn}>
        {step === "approving"
          ? "Approving token…"
          : step === "swapping"
            ? "Submitting swap…"
            : step === "confirming"
              ? "Waiting for confirmation…"
              : step === "done"
                ? "Done ✓"
                : needsApproval
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

const btn: React.CSSProperties = {
  padding: "12px 20px",
  fontSize: 16,
  borderRadius: 8,
  border: "none",
  background: "#0066ff",
  color: "white",
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
    <p style={{ color: "crimson", marginTop: 12, wordBreak: "break-word" }}>
      {children}
    </p>
  );
}
