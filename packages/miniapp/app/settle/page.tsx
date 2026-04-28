// /settle — submit settle(dealHash) (SPEC §6.2 step 4).
//
// Once both sides have locked, anyone can call settle(dealHash). The User
// Agent prompts the user from the Mini App so the User Agent itself never
// needs spendable balance. (The MM Agent has it as a fallback if the user's
// session expires.)
//
// URL: /settle?deal_hash=<bytes32>

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

const SETTLEMENT_ADDRESS = (process.env["NEXT_PUBLIC_SETTLEMENT_CONTRACT_ADDRESS"] ??
  "0x0000000000000000000000000000000000000000") as Hex;

const SETTLEMENT_ABI = parseAbi([
  "function settle(bytes32 dealHash)",
]);

type Step = "idle" | "submitting" | "confirming" | "done";

function SettleInner() {
  const params = useSearchParams();
  const dealHash = params.get("deal_hash") as Hex | null;

  const { isConnected, chainId } = useAccount();
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
        <h1>Settle</h1>
        <ErrLine>
          Missing or malformed <code>deal_hash</code> in URL (expected 0x + 64 hex chars).
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
      const tx = await writeContractAsync({
        address: SETTLEMENT_ADDRESS,
        abi: SETTLEMENT_ABI,
        functionName: "settle",
        args: [dealHash],
      });
      setTxHash(tx);
      setStep("confirming");
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
      }
      setStep("done");
      sendResult({ kind: "settled", txHash: tx, dealId: dealHash });
    } catch (err) {
      setError((err as Error).message);
      setStep("idle");
    }
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Settle</h1>
        <p style={{ opacity: 0.7 }}>Connect your wallet to settle.</p>
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
      <h1>Settle trade</h1>
      <p style={{ wordBreak: "break-all" }}>Deal: <code>{dealHash}</code></p>
      <p style={{ fontSize: 13, opacity: 0.7 }}>
        Both sides have locked their tokens. Tap below to release the swap atomically. You pay gas.
      </p>
      <button onClick={submit} disabled={step !== "idle"} style={btn}>
        {step === "submitting"
          ? "Submitting…"
          : step === "confirming"
            ? "Waiting for confirmation…"
            : step === "done"
              ? "Done ✓"
              : "Submit settle()"}
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

export default function Settle() {
  return (
    <Suspense fallback={<Page><p>Loading…</p></Page>}>
      <SettleInner />
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
    <main style={{ padding: 24, fontFamily: "system-ui", lineHeight: 1.5, maxWidth: 480 }}>
      {children}
    </main>
  );
}

function ErrLine({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "crimson", marginTop: 12, wordBreak: "break-word" }}>{children}</p>;
}
