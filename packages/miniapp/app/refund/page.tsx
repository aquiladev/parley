// /refund — submit refund(dealHash) after deadline if the trade is stuck
// (SPEC §6.2 step 5). Anyone can call refund once block.timestamp >= deadline
// AND the deal is in UserLocked or BothLocked state. By convention the user
// submits from their own wallet so the User Agent never needs gas.
//
// URL: /refund?deal_hash=<bytes32>

"use client";

import { Suspense, useState } from "react";
import {
  useAccount,
  useConnect,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import { parseAbi, type Hex } from "viem";
import { sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";
import { MiniAppHeader } from "../../lib/header";
import { formatTxError } from "../../lib/tx-error";
import { estimateContractOverrides } from "../../lib/gas-estimator";

const SETTLEMENT_ADDRESS = (process.env["NEXT_PUBLIC_SETTLEMENT_CONTRACT_ADDRESS"] ??
  "0x0000000000000000000000000000000000000000") as Hex;

const SETTLEMENT_ABI = parseAbi([
  "function refund(bytes32 dealHash)",
]);

type Step = "idle" | "submitting" | "confirming" | "done";

function RefundInner() {
  const params = useSearchParams();
  const dealHash = params.get("deal_hash") as Hex | null;
  const expectedWallet = params.get("wallet") as Hex | null;

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  const [step, setStep] = useState<Step>("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!dealHash || !/^0x[0-9a-fA-F]{64}$/.test(dealHash)) {
    return (
      <Page>
        <h1>Refund</h1>
        <ErrLine>
          Missing or malformed <code>deal_hash</code> in URL.
        </ErrLine>
      </Page>
    );
  }

  async function submit() {
    if (!dealHash) return;
    setError(null);
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }
      setStep("submitting");
      // Pre-fill gas params (see lib/gas-estimator.ts).
      const overrides = publicClient && address
        ? await estimateContractOverrides(publicClient, {
            address: SETTLEMENT_ADDRESS,
            abi: SETTLEMENT_ABI,
            functionName: "refund",
            args: [dealHash],
            account: address,
          })
        : undefined;
      const tx = await writeContractAsync({
        address: SETTLEMENT_ADDRESS,
        abi: SETTLEMENT_ABI,
        functionName: "refund",
        args: [dealHash],
        ...(overrides ?? {}),
      });
      setTxHash(tx);
      setStep("confirming");
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
      }
      setStep("done");
      sendResult({ kind: "refunded", txHash: tx, dealId: dealHash });
    } catch (err) {
      setError(formatTxError(err));
      setStep("idle");
    }
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Refund</h1>
        <p style={{ color: "var(--parley-hint)" }}>
          {expectedWallet
            ? <>Connect wallet <code>{shortAddr(expectedWallet)}</code> to refund.</>
            : "Connect your wallet to refund."}
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

  // Soft warning, no block — refund() is permissionless. The original locker
  // gets their tokens back regardless of which wallet calls refund.
  const walletMismatch =
    expectedWallet &&
    address &&
    expectedWallet.toLowerCase() !== address.toLowerCase();

  return (
    <Page>
      <h1>Refund stuck trade</h1>
      <p style={{ wordBreak: "break-all" }}>Deal: <code>{dealHash}</code></p>
      <p style={{ fontSize: 13, color: "var(--parley-hint)" }}>
        The deadline has passed and at least one side never locked. Tap below to
        recover your tokens. The contract reverts (cleanly) if the deadline
        hasn't actually passed yet — re-try later in that case.
      </p>
      {walletMismatch && (
        <div style={softNotice}>
          <b>Heads up:</b> tokens are locked under{" "}
          <code>{shortAddr(expectedWallet!)}</code>; you've connected{" "}
          <code>{shortAddr(address!)}</code>. You can still submit — refund is
          permissionless — but the recovered tokens go to the original wallet,
          not this one.
        </div>
      )}
      <button onClick={submit} disabled={step !== "idle"} style={btn}>
        {step === "submitting"
          ? "Submitting…"
          : step === "confirming"
            ? "Waiting for confirmation…"
            : step === "done"
              ? "Done ✓"
              : "Submit refund()"}
      </button>
      {txHash && (
        <p style={{ marginTop: 12, fontSize: 13 }}>
          tx:{" "}
          <a href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">
            {short(txHash)}
          </a>
        </p>
      )}
      {error && <ErrLine>{error}</ErrLine>}
    </Page>
  );
}

export default function Refund() {
  return (
    <Suspense fallback={<Page><p>Loading…</p></Page>}>
      <RefundInner />
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
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}>
      <MiniAppHeader />
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--parley-error)", marginTop: 12, wordBreak: "break-word" }}>{children}</p>;
}
