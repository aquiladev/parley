// Phase 3: register an MM Agent's ENS subname under parley.eth on Sepolia.
//
// Reads from .env:
//   PARLEY_ROOT_PRIVATE_KEY  — owns parley.eth, signs the registration txs
//   MM_ENS_NAME              — full subname to register, e.g. mm-1.parley.eth
//   MM_EVM_PRIVATE_KEY       — derives the addr text record value (the MM's
//                              hot wallet that signs deals on-chain)
//   KNOWN_MM_AXL_PUBKEYS     — first entry is treated as this MM's axl_pubkey
//                              (Phase 3 still has 1 MM; multi-MM Phase 5)
//   SEPOLIA_RPC_URL
//
// What it does (three transactions, all signed by PARLEY_ROOT):
//   1. Registry.setSubnodeRecord(parentNode, labelhash, PARLEY_ROOT, resolver, 0)
//      — creates (or re-owns) the subname, points it at the same resolver
//        parley.eth uses. PARLEY_ROOT keeps ownership for the next step so
//        it can write records.
//   2. Resolver.multicall([setAddr, setText('axl_pubkey'), setText('agent_capabilities')])
//      — sets the records the verifier consumes (SPEC §4.4). Empty records
//        (reputation_root, avatar) are skipped — Phase 4's MM Agent writes
//        reputation_root after the first trade.
//   3. Registry.setOwner(subnode, MM_EVM)
//      — transfers ownership to the MM. Now MM_EVM can update its own
//        reputation_root via Resolver.setText. Phase 4B requirement.
//        PARLEY_ROOT (parent owner) can always reclaim via setSubnodeOwner.
// Run: pnpm -F @parley/user-agent phase3:register-mm

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

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`env var ${name} is required`);
  return v;
}

const PRIVATE_KEY = required("PARLEY_ROOT_PRIVATE_KEY") as Hex;
const MM_ENS_NAME = required("MM_ENS_NAME"); // e.g. mm-1.parley.eth
const MM_PK = required("MM_EVM_PRIVATE_KEY") as Hex;
const KNOWN_MM_AXL_PUBKEYS = required("KNOWN_MM_AXL_PUBKEYS");
const RPC_URL = required("SEPOLIA_RPC_URL");

const labelParts = MM_ENS_NAME.split(".");
if (labelParts.length < 3) {
  throw new Error(`MM_ENS_NAME must be a subname (e.g. mm-1.parley.eth), got: ${MM_ENS_NAME}`);
}
const label = labelParts[0]!;
const parentName = labelParts.slice(1).join(".");
const parentNode = namehash(parentName);
const labelHash = keccak256(toHex(label));
const subnode = namehash(MM_ENS_NAME);

const axlPubkey = KNOWN_MM_AXL_PUBKEYS.split(",").map((s) => s.trim()).filter(Boolean)[0];
if (!axlPubkey) throw new Error("KNOWN_MM_AXL_PUBKEYS is empty");

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
  parent: parentName,
  subname: MM_ENS_NAME,
  parent_node: parentNode,
  subnode,
  label_hash: labelHash,
  parley_root: root.address,
  mm_evm_address: mmEvmAddress,
  axl_pubkey: axlPubkey,
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
