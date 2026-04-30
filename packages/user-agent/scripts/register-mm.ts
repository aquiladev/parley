// Phase 3: register an MM Agent's ENS subname under parley.eth on Sepolia.
//
// Usage:
//   pnpm phase3:register-mm                              # registers MM_ENS_NAME (mm-1)
//   pnpm phase3:register-mm -- --mm 2                    # registers MM2_ENS_NAME (mm-2)
//   pnpm phase3:register-mm -- --ens X --key Y           # explicit overrides
//   pnpm phase3:register-mm -- --axl-pem path/to/pem     # derive pubkey from PEM (default)
//   pnpm phase3:register-mm -- --axl-pubkey 64hex        # supply pubkey directly
//
// Inputs (CLI flags > env). When `--mm <n>` is given the env prefix becomes
// MM<n>_ for n>1 (legacy MM_ for n=1) and the default AXL PEM path becomes
// infra/state/mm-agent-<n>/axl.pem.
//
// Reads from .env (always):
//   PARLEY_ROOT_PRIVATE_KEY  — owns parley.eth, signs the registration txs
//   SEPOLIA_RPC_URL
//
// Reads per-MM (CLI flag overrides env):
//   --ens          <- MM_ENS_NAME / MM<n>_ENS_NAME
//   --key          <- MM_EVM_PRIVATE_KEY / MM<n>_EVM_PRIVATE_KEY
//   --axl-pem      <- (default) infra/state/mm-agent[-n]/axl.pem
//   --axl-pubkey   <- (fallback) KNOWN_MM_AXL_PUBKEYS[n-1]
//
// AXL pubkey derivation: for an ed25519 PEM, the raw 32-byte public key is
// the last 32 bytes of the SPKI DER. Verified against axl-node's /topology
// `our_public_key` — they match byte-for-byte.
//
// What it does (three transactions, all signed by PARLEY_ROOT):
//   1. Registry.setSubnodeRecord — creates / re-owns the subname.
//   2. Resolver.multicall([setAddr, setText('axl_pubkey'), setText('agent_capabilities')])
//   3. Registry.setOwner(subnode, MM_EVM) — transfers ownership so MM can
//      update its own reputation_root via Resolver.setText (Phase 4B).
// Run: pnpm -F @parley/user-agent phase3:register-mm

import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// Sepolia ENS contracts
const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const NAMEWRAPPER = "0x0635513f179D50A207757E05759CbD106d7dFcE8" as const;

const REGISTRY_ABI = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
  "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)",
  "function setOwner(bytes32 node, address owner)",
]);

const RESOLVER_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
  "function setAddr(bytes32 node, address a)",
  "function setText(bytes32 node, string key, string value)",
  "function multicall(bytes[] data) returns (bytes[])",
]);

// ---- CLI parsing ---------------------------------------------------------

// pnpm 10 forwards a literal `--` separator before script args
// (`node ... script.ts -- --mm 2`). Node's parseArgs treats `--` as
// end-of-options, so we strip it so both invocation styles work:
//   node script.ts --mm 2
//   pnpm phase3:register-mm -- --mm 2
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

const { values: args } = parseArgs({
  args: rawArgs,
  options: {
    mm: { type: "string" },
    ens: { type: "string" },
    key: { type: "string" },
    "axl-pem": { type: "string" },
    "axl-pubkey": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
});

if (args.help) {
  process.stdout.write(
    [
      "Usage: pnpm phase3:register-mm -- [--mm <n>] [--ens <name>] [--key <hex>] [--axl-pem <path> | --axl-pubkey <hex>]",
      "",
      "  --mm <n>        index 1..N. n=1 reads MM_*; n>=2 reads MM<n>_*. Default 1.",
      "  --ens           override the ENS subname (e.g. mm-2.parley.eth)",
      "  --key           override the MM EVM private key",
      "  --axl-pem       path to MM's ed25519 axl.pem; pubkey derived from it",
      "  --axl-pubkey    explicit 64-hex AXL pubkey (skips PEM read)",
      "",
      "Defaults resolve from .env using the index:",
      "  --mm 1: MM_ENS_NAME, MM_EVM_PRIVATE_KEY, infra/state/mm-agent/axl.pem",
      "  --mm 2: MM2_ENS_NAME, MM2_EVM_PRIVATE_KEY, infra/state/mm-agent-2/axl.pem",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const mmIndex = args.mm ? parseInt(args.mm, 10) : 1;
if (!Number.isInteger(mmIndex) || mmIndex < 1) {
  throw new Error(`--mm must be a positive integer, got: ${args.mm}`);
}
const envPrefix = mmIndex === 1 ? "MM" : `MM${mmIndex}`;
const stateDir = mmIndex === 1 ? "mm-agent" : `mm-agent-${mmIndex}`;

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`env var ${name} is required`);
  return v;
}

function pickRequired(cliVal: string | undefined, envName: string, label: string): string {
  if (cliVal && cliVal !== "") return cliVal;
  const v = process.env[envName];
  if (!v || v === "") {
    throw new Error(`${label} required (pass --${label.toLowerCase()} or set ${envName})`);
  }
  return v;
}

const PRIVATE_KEY = required("PARLEY_ROOT_PRIVATE_KEY") as Hex;
const RPC_URL = required("SEPOLIA_RPC_URL");

const MM_ENS_NAME = pickRequired(args.ens, `${envPrefix}_ENS_NAME`, "ens");
const MM_PK = pickRequired(args.key, `${envPrefix}_EVM_PRIVATE_KEY`, "key") as Hex;

// AXL pubkey resolution: explicit > PEM-derived > KNOWN_MM_AXL_PUBKEYS[index-1].
function resolveAxlPubkey(): { pubkey: string; source: string } {
  if (args["axl-pubkey"] && args["axl-pubkey"] !== "") {
    return { pubkey: normalizeHex(args["axl-pubkey"]), source: "cli:--axl-pubkey" };
  }
  // Try PEM (CLI path, then default per-index path).
  const pemPath = args["axl-pem"]
    ? resolve(args["axl-pem"])
    : resolve(process.cwd(), "..", "..", "infra", "state", stateDir, "axl.pem");
  if (existsSync(pemPath)) {
    const pem = readFileSync(pemPath, "utf8");
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    const der = publicKey.export({ format: "der", type: "spki" });
    // ed25519 SPKI is a fixed 44-byte DER; the last 32 bytes are the raw key.
    const rawPubkey = der.subarray(der.length - 32).toString("hex");
    return { pubkey: rawPubkey, source: `pem:${pemPath}` };
  }
  // Fallback: KNOWN_MM_AXL_PUBKEYS env (Phase 1 single-MM path).
  const env = process.env.KNOWN_MM_AXL_PUBKEYS;
  if (env && env !== "") {
    const list = env.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = mmIndex - 1;
    const candidate = list[idx];
    if (candidate) {
      return { pubkey: normalizeHex(candidate), source: `env:KNOWN_MM_AXL_PUBKEYS[${idx}]` };
    }
  }
  throw new Error(
    `axl_pubkey unresolved: ${pemPath} not found, --axl-pubkey not given, and KNOWN_MM_AXL_PUBKEYS[${mmIndex - 1}] is empty.`,
  );
}

function normalizeHex(s: string): string {
  return s.trim().toLowerCase().replace(/^0x/, "");
}

// ---- Resolve identity ----------------------------------------------------

const labelParts = MM_ENS_NAME.split(".");
if (labelParts.length < 3) {
  throw new Error(`ens must be a subname (e.g. mm-1.parley.eth), got: ${MM_ENS_NAME}`);
}
const label = labelParts[0]!;
const parentName = labelParts.slice(1).join(".");
const parentNode = namehash(parentName);
const labelHash = keccak256(toHex(label));
const subnode = namehash(MM_ENS_NAME);

const { pubkey: axlPubkey, source: axlPubkeySource } = resolveAxlPubkey();
if (axlPubkey.length !== 64) {
  throw new Error(`axl_pubkey must be 64 hex chars (32 bytes), got ${axlPubkey.length}: ${axlPubkey}`);
}

const mmEvmAddress = privateKeyToAccount(MM_PK).address;
const root = privateKeyToAccount(PRIVATE_KEY);

const capabilities = JSON.stringify({
  chain: "sepolia",
  pairs: ["USDC/WETH"],
  version: "1",
});

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = createWalletClient({ chain: sepolia, transport, account: root });

function log(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

log({
  event: "boot",
  mm_index: mmIndex,
  parent: parentName,
  subname: MM_ENS_NAME,
  parent_node: parentNode,
  subnode,
  label_hash: labelHash,
  parley_root: root.address,
  mm_evm_address: mmEvmAddress,
  axl_pubkey: axlPubkey,
  axl_pubkey_source: axlPubkeySource,
});

// ---- 1. Verify parent ownership ------------------------------------------

const parentOwner = (await publicClient.readContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "owner",
  args: [parentNode],
})) as Hex;

if (parentOwner.toLowerCase() === NAMEWRAPPER.toLowerCase()) {
  throw new Error(
    `${parentName} is wrapped (Registry.owner == NameWrapper). This script handles the legacy unwrapped path only — extend to NameWrapper.setSubnodeRecord if needed.`,
  );
}
if (parentOwner.toLowerCase() !== root.address.toLowerCase()) {
  throw new Error(
    `${parentName} is owned by ${parentOwner}, not by PARLEY_ROOT_PRIVATE_KEY's address ${root.address}. Cannot register subname.`,
  );
}
log({ event: "parent_owner_ok", owner: parentOwner });

// Resolver inherited from parent (good default — same resolver as parley.eth).
const resolverAddress = (await publicClient.readContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "resolver",
  args: [parentNode],
})) as Hex;
log({ event: "resolver", address: resolverAddress });

// ---- 2. Create / re-own the subname --------------------------------------

// Step 1: create the subname owned by PARLEY_ROOT (so this script can
// keep going without involving the MM key).
const txCreate = await walletClient.writeContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "setSubnodeRecord",
  args: [parentNode, labelHash, root.address, resolverAddress, 0n],
});
await publicClient.waitForTransactionReceipt({ hash: txCreate, confirmations: 1 });
log({ event: "subname_created_or_updated", tx: txCreate, owner: root.address });

// ---- 3. Set records via Resolver.multicall -------------------------------

const setAddrCalldata = encodeFunctionData({
  abi: RESOLVER_ABI,
  functionName: "setAddr",
  args: [subnode, mmEvmAddress],
});
const setAxlPubkeyCalldata = encodeFunctionData({
  abi: RESOLVER_ABI,
  functionName: "setText",
  args: [subnode, "axl_pubkey", axlPubkey],
});
const setCapabilitiesCalldata = encodeFunctionData({
  abi: RESOLVER_ABI,
  functionName: "setText",
  args: [subnode, "agent_capabilities", capabilities],
});

const txRecords = await walletClient.writeContract({
  address: resolverAddress,
  abi: RESOLVER_ABI,
  functionName: "multicall",
  args: [[setAddrCalldata, setAxlPubkeyCalldata, setCapabilitiesCalldata]],
});
await publicClient.waitForTransactionReceipt({ hash: txRecords, confirmations: 1 });
log({ event: "records_set", tx: txRecords });

// ---- 4. Transfer subname ownership to MM_EVM -----------------------------
// Phase 4B: MM updates its own reputation_root after each trade, which
// requires owning (or being approved on) the subname.

const currentOwner = (await publicClient.readContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: "owner",
  args: [subnode],
})) as Hex;

if (currentOwner.toLowerCase() === mmEvmAddress.toLowerCase()) {
  log({ event: "ownership_already_mm", owner: currentOwner });
} else {
  const txTransfer = await walletClient.writeContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "setOwner",
    args: [subnode, mmEvmAddress],
  });
  await publicClient.waitForTransactionReceipt({ hash: txTransfer, confirmations: 1 });
  log({ event: "ownership_transferred_to_mm", tx: txTransfer, new_owner: mmEvmAddress });
}

// ---- 5. Re-resolve to confirm --------------------------------------------

const [resolvedAddr, resolvedAxl, resolvedCaps] = await Promise.all([
  publicClient.getEnsAddress({ name: MM_ENS_NAME }),
  publicClient.getEnsText({ name: MM_ENS_NAME, key: "axl_pubkey" }),
  publicClient.getEnsText({ name: MM_ENS_NAME, key: "agent_capabilities" }),
]);

const ok =
  resolvedAddr?.toLowerCase() === mmEvmAddress.toLowerCase() &&
  resolvedAxl === axlPubkey &&
  resolvedCaps === capabilities;

log({
  event: ok ? "verified" : "verification_failed",
  resolved_addr: resolvedAddr,
  resolved_axl_pubkey: resolvedAxl,
  resolved_capabilities: resolvedCaps,
});

if (!ok) {
  process.exit(1);
}
