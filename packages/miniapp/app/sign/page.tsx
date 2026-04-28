// /sign — accepted-offer flow (SPEC §10.2).
//
// Single Mini App session that completes BOTH steps before closing:
//   1. signTypedData(Deal) → userSig
//   2. writeContract({ functionName: "lockUserSide", args: [deal, userSig] })
//   3. sendData({ kind: "lock_submitted", txHash, dealId }) and close
//
// URL: /sign?deal=<URL-encoded JSON DealTerms>&offer_id=<offer_id>
//
// Phase 2 caveats:
//  - Assumes the user has already approved the Settlement contract to spend
//    tokenA out-of-band. Approval prompting + Permit2 land in Phase 4.
//  - Amounts displayed in raw wei. Wallet's typed-data prompt is the source
//    of truth the user verifies against.

"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { useSearchParams } from "next/navigation";
import { hashTypedData, parseAbi, type Hex } from "viem";
import {
  ACCEPT_AUTHORIZATION_EIP712_TYPES,
  DEAL_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  type DealTerms,
} from "@parley/shared";
import { sendResult } from "../../lib/telegram";
import { SEPOLIA_CHAIN_ID } from "../../lib/walletconnect";
import { MiniAppHeader } from "../../lib/header";

const SETTLEMENT_ADDRESS = (process.env["NEXT_PUBLIC_SETTLEMENT_CONTRACT_ADDRESS"] ??
  "0x0000000000000000000000000000000000000000") as Hex;

const SETTLEMENT_ABI = parseAbi([
  "function lockUserSide((address user,address mm,address tokenA,address tokenB,uint256 amountA,uint256 amountB,uint256 deadline,uint256 nonce) deal, bytes userSig)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
]);

const MAX_UINT256 = 2n ** 256n - 1n;

type Step =
  | "idle"
  | "checking_allowance"
  | "needs_approval"
  | "approving"
  | "signing"
  | "submitting"
  | "confirming"
  | "done";

function SignInner() {
  const params = useSearchParams();
  const dealJson = params.get("deal");
  const offerId = params.get("offer_id");
  const tid = params.get("tid");

  const { isConnected, address, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();

  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);

  // Re-check allowance whenever connection / deal changes.
  useEffect(() => {
    if (!isConnected || !address || !publicClient || !dealJson) return;
    let cancelled = false;
    (async () => {
      setStep("checking_allowance");
      try {
        const parsed = JSON.parse(dealJson) as DealTerms;
        const a = (await publicClient.readContract({
          address: parsed.tokenA,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, SETTLEMENT_ADDRESS],
        })) as bigint;
        if (cancelled) return;
        setAllowance(a);
        setStep(a < BigInt(parsed.amountA) ? "needs_approval" : "idle");
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setStep("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isConnected, address, publicClient, dealJson]);

  const deal = useMemo<DealTerms | null>(() => {
    if (!dealJson) return null;
    try {
      return JSON.parse(dealJson) as DealTerms;
    } catch {
      return null;
    }
  }, [dealJson]);

  if (!dealJson || !offerId || !tid) {
    return (
      <Page>
        <h1>Sign and lock</h1>
        <ErrLine>
          Missing <code>deal</code>, <code>offer_id</code>, or <code>tid</code> in URL.
        </ErrLine>
      </Page>
    );
  }
  if (!deal) {
    return (
      <Page>
        <h1>Sign and lock</h1>
        <ErrLine>Malformed deal JSON. The bot must URL-encode a valid DealTerms object.</ErrLine>
      </Page>
    );
  }

  const dealMessage = {
    user: deal.user,
    mm: deal.mm,
    tokenA: deal.tokenA,
    tokenB: deal.tokenB,
    amountA: BigInt(deal.amountA),
    amountB: BigInt(deal.amountB),
    deadline: BigInt(deal.deadline),
    nonce: BigInt(deal.nonce),
  };

  if (isConnected && address && deal.user.toLowerCase() !== address.toLowerCase()) {
    return (
      <Page>
        <h1>Wrong wallet</h1>
        <ErrLine>
          Deal binds wallet <code>{deal.user.slice(0, 10)}…</code>, but the connected wallet
          is <code>{address.slice(0, 10)}…</code>. Disconnect and reconnect with the matching
          wallet.
        </ErrLine>
      </Page>
    );
  }

  async function approve() {
    if (!deal || !publicClient) return;
    setError(null);
    try {
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }
      setStep("approving");
      const tx = await writeContractAsync({
        address: deal.tokenA,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [SETTLEMENT_ADDRESS, MAX_UINT256],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
      setAllowance(MAX_UINT256);
      setStep("idle");
    } catch (err) {
      setError((err as Error).message);
      setStep("needs_approval");
    }
  }

  async function signAndSubmit() {
    if (!address || !deal || !offerId || !tid) return;
    setError(null);
    try {
      // Settlement contract lives on Sepolia; both the typed-data domain and
      // the on-chain submission require the wallet to be on the same chain.
      if (chainId !== SEPOLIA_CHAIN_ID) {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      }

      // 1/3: Deal signature — the EIP-712 sig the contract recovers in
      // lockUserSide; also reused as the AXL Accept envelope's signature.
      setStep("signing");
      const dealSig = await signTypedDataAsync({
        domain: { ...PARLEY_EIP712_DOMAIN, verifyingContract: SETTLEMENT_ADDRESS },
        types: DEAL_EIP712_TYPES,
        primaryType: "Deal",
        message: dealMessage,
      });

      // 2/3: AcceptAuthorization — required by axl-mcp.send_accept (§4.3).
      // The dealHash is the contract's view of the Deal — viem's hashTypedData
      // produces the same digest the on-chain dealHash() returns and that
      // ECDSA.recover used inside lockUserSide just verified.
      const dealHashHex = hashTypedData({
        domain: { ...PARLEY_EIP712_DOMAIN, verifyingContract: SETTLEMENT_ADDRESS },
        types: DEAL_EIP712_TYPES,
        primaryType: "Deal",
        message: dealMessage,
      });
      const issuedAt = Math.floor(Date.now() / 1000);
      const acceptAuth = {
        offer_id: offerId,
        deal_hash: dealHashHex,
        telegram_user_id: tid,
        issued_at: issuedAt,
      };
      const acceptAuthSig = await signTypedDataAsync({
        domain: PARLEY_EIP712_DOMAIN,
        types: ACCEPT_AUTHORIZATION_EIP712_TYPES,
        primaryType: "AcceptAuthorization",
        message: {
          offer_id: acceptAuth.offer_id,
          deal_hash: acceptAuth.deal_hash,
          telegram_user_id: BigInt(acceptAuth.telegram_user_id),
          issued_at: BigInt(acceptAuth.issued_at),
        },
      });

      // 3/3: lockUserSide submission.
      setStep("submitting");
      const tx = await writeContractAsync({
        address: SETTLEMENT_ADDRESS,
        abi: SETTLEMENT_ABI,
        functionName: "lockUserSide",
        args: [dealMessage, dealSig],
      });
      setTxHash(tx);

      setStep("confirming");
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: tx, confirmations: 1 });
      }
      setStep("done");
      sendResult({
        kind: "lock_submitted",
        txHash: tx,
        dealId: offerId,
        deal_sig: dealSig,
        accept_auth: acceptAuth,
        accept_auth_sig: acceptAuthSig,
      });
    } catch (err) {
      setError((err as Error).message);
      setStep("idle");
    }
  }

  if (!isConnected) {
    return (
      <Page>
        <h1>Sign and lock</h1>
        <p style={{ opacity: 0.7 }}>Connect your wallet to continue.</p>
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
      <h1>Confirm trade</h1>
      <ul style={list}>
        <li><b>You give:</b> <code>{deal.amountA}</code> wei of <code>{short(deal.tokenA)}</code></li>
        <li><b>You get:</b> <code>{deal.amountB}</code> wei of <code>{short(deal.tokenB)}</code></li>
        <li><b>MM:</b> <code>{short(deal.mm)}</code></li>
        <li><b>Deadline:</b> {new Date(deal.deadline * 1000).toLocaleString()}</li>
      </ul>
      <p style={{ fontSize: 13, opacity: 0.7 }}>
        Your wallet will show the full deal in the EIP-712 prompt. Verify the
        amounts there before approving.
      </p>
      {step === "checking_allowance" && (
        <p style={{ fontSize: 13, opacity: 0.7 }}>Checking token allowance…</p>
      )}
      {step === "needs_approval" || step === "approving" ? (
        <>
          <p style={{ fontSize: 13, opacity: 0.7 }}>
            Settlement isn't yet approved to spend your token. One-time on-chain
            approval is required before you can lock.
          </p>
          <button onClick={approve} disabled={step === "approving"} style={btn}>
            {step === "approving" ? "Approving…" : "Approve token"}
          </button>
        </>
      ) : (
        <button
          onClick={signAndSubmit}
          disabled={step !== "idle"}
          style={btn}
        >
          {step === "signing"
            ? "Signing…"
            : step === "submitting"
              ? "Submitting tx…"
              : step === "confirming"
                ? "Waiting for confirmation…"
                : step === "done"
                  ? "Done ✓"
                  : "Sign + lock"}
        </button>
      )}
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

export default function SignFlow() {
  return (
    <Suspense fallback={<Page><p>Loading…</p></Page>}>
      <SignInner />
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

const list: React.CSSProperties = {
  background: "#f6f6f6",
  borderRadius: 8,
  padding: "12px 20px",
  listStyle: "none",
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
  return <p style={{ color: "crimson", marginTop: 12, wordBreak: "break-word" }}>{children}</p>;
}
