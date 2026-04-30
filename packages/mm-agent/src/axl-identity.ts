// AXL identity ↔ ENS sync for the MM Agent.
//
// On every boot we verify that the `axl_pubkey` ENS text record on
// `MM_ENS_NAME` matches the pubkey of the locally mounted axl.pem. If they
// drift (after a key rotation, fresh `make axl-keys`, or a new deployment),
// this module updates the ENS record from `MM_EVM` — the subname owner
// post-Phase-3 ownership transfer.
//
// Without this sync the User Agent dials a stale overlay IPv6 derived from
// the OUTDATED ENS pubkey; the Yggdrasil mesh has no node at that address,
// and `/send` hangs in a 127s gVisor TCP SYN timeout. See sync_log entries
// for how this manifests.
//
// Opt-out via `MM_AUTO_REGISTER_AXL=false` — the boot then refuses to start
// when ENS is stale, surfacing a clear operator-fix path instead of writing
// the chain. Safe default for production where chain writes should be
// reviewed; default-on for dev/testnet where the friction would be worse
// than the convenience of self-healing.

import {
  createPublicClient,
  createWalletClient,
  http,
  namehash,
  parseAbi,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const REGISTRY_ABI = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
]);
const RESOLVER_ABI = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value)",
]);

export interface AxlIdentitySyncConfig {
  mmEnsName: string;
  rpcUrl: string;
  /** MM_EVM — subname owner, signs the ENS update. */
  privateKey: Hex;
  /** AXL HTTP API base, e.g. http://localhost:9002. The /topology endpoint
   *  surfaces this node's actual ed25519 public key. */
  axlHttpUrl: string;
  /** When false, refuse to start on mismatch instead of self-healing.
   *  Defaults to true. */
  autoRegister?: boolean;
}

export interface SyncResult {
  status: "in_sync" | "self_healed" | "skipped_no_internet" | "would_self_heal_but_disabled";
  local_pubkey: string;
  ens_pubkey: string | null;
  ens_tx?: Hex;
}

export async function ensureAxlPubkeyOnEns(
  cfg: AxlIdentitySyncConfig,
  log: (event: Record<string, unknown>) => void,
): Promise<SyncResult> {
  const localPubkey = await readLocalAxlPubkey(cfg.axlHttpUrl);

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(cfg.rpcUrl),
  });
  const subnode = namehash(cfg.mmEnsName);

  // Resolve resolver address from Registry.
  let resolver: Hex;
  try {
    resolver = (await publicClient.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "resolver",
      args: [subnode],
    })) as Hex;
  } catch (err) {
    // Sepolia RPC down — don't block boot. Trades will surface the stale-
    // pubkey symptom on first broadcast attempt anyway, and recovering by
    // restarting once RPC is back is cheap.
    log({
      event: "axl_identity_sync_skipped",
      reason: "registry_read_failed",
      err: (err as Error).message,
    });
    return {
      status: "skipped_no_internet",
      local_pubkey: localPubkey,
      ens_pubkey: null,
    };
  }

  if (resolver === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `${cfg.mmEnsName} has no resolver — run \`pnpm phase3:register-mm\` first`,
    );
  }

  // Read current ENS axl_pubkey.
  let ensPubkey: string;
  try {
    ensPubkey = (await publicClient.readContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: "text",
      args: [subnode, "axl_pubkey"],
    })) as string;
  } catch (err) {
    log({
      event: "axl_identity_sync_skipped",
      reason: "text_read_failed",
      err: (err as Error).message,
    });
    return {
      status: "skipped_no_internet",
      local_pubkey: localPubkey,
      ens_pubkey: null,
    };
  }

  if (normalizeHex(ensPubkey) === normalizeHex(localPubkey)) {
    log({
      event: "axl_identity_in_sync",
      ens_name: cfg.mmEnsName,
      pubkey: localPubkey,
    });
    return {
      status: "in_sync",
      local_pubkey: localPubkey,
      ens_pubkey: ensPubkey,
    };
  }

  // Mismatch — either auto-heal or fail-fast.
  const autoRegister = cfg.autoRegister ?? true;
  if (!autoRegister) {
    log({
      event: "axl_identity_drift_detected_auto_register_disabled",
      ens_name: cfg.mmEnsName,
      local_pubkey: localPubkey,
      ens_pubkey: ensPubkey,
    });
    throw new Error(
      `AXL pubkey on ENS (${ensPubkey || "<unset>"}) does not match the local axl.pem ` +
        `(${localPubkey}). MM_AUTO_REGISTER_AXL=false — refusing to self-heal. ` +
        `Run \`pnpm phase3:register-mm\` (or unset MM_AUTO_REGISTER_AXL) to fix.`,
    );
  }

  log({
    event: "axl_identity_drift_detected_self_healing",
    ens_name: cfg.mmEnsName,
    local_pubkey: localPubkey,
    ens_pubkey: ensPubkey || "<unset>",
  });

  const account = privateKeyToAccount(cfg.privateKey);
  const walletClient = createWalletClient({
    chain: sepolia,
    transport: http(cfg.rpcUrl),
    account,
  });
  const ensTx = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: "setText",
    args: [subnode, "axl_pubkey", localPubkey],
  });
  // Don't wait for receipt — by the time the User Agent first calls
  // broadcast_intent the tx will have landed. Eventually-consistent ENS reads
  // are fine for our use case.
  log({
    event: "axl_identity_self_healed",
    ens_name: cfg.mmEnsName,
    pubkey: localPubkey,
    tx: ensTx,
  });
  return {
    status: "self_healed",
    local_pubkey: localPubkey,
    ens_pubkey: ensPubkey,
    ens_tx: ensTx,
  };
}

async function readLocalAxlPubkey(axlHttpUrl: string): Promise<string> {
  const res = await fetch(`${axlHttpUrl}/topology`);
  if (!res.ok) {
    throw new Error(`AXL /topology returned ${res.status}; cannot read local pubkey`);
  }
  const t = (await res.json()) as { our_public_key?: string; ourPublicKey?: string };
  // axl-node exposes either casing depending on version; accept both.
  const pubkey = t.our_public_key ?? t.ourPublicKey;
  if (!pubkey) {
    throw new Error("AXL /topology response missing our_public_key");
  }
  return pubkey;
}

function normalizeHex(s: string): string {
  return s.trim().toLowerCase().replace(/^0x/, "");
}
