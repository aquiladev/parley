// Reputation publish path for the MM Agent (SPEC §7.2 "robust" option).
//
// On each terminal trade outcome:
//   1. Upload the TradeRecord JSON blob to 0G Storage → record root hash.
//   2. Read the CURRENT index blob via ENS reputation_root (canonical
//      source of truth — no local cache, so history survives container
//      restarts and volume loss).
//   3. Append the new record hash, upload the new index blob → index hash.
//   4. setText("reputation_root", indexHash) on the MM's ENS subname so
//      readers see the cumulative history.
//
// og-mcp's read_mm_reputation reverses the flow: resolve ENS → fetch index
// blob → fetch each record → score.
//
// Why no local file: a previous version cached the index in
// ~/.parley/mm-records.json. Without a volume mount, container restarts
// reset that file to empty, and the next publish would emit an index with
// only post-restart trades — orphaning all prior records (the blobs
// persisted in 0G, but ENS no longer pointed at them). Reading from ENS
// each time costs one extra 0G download per trade and eliminates the
// silent-data-loss class entirely.
//
// Concurrency: same-instance concurrent publishes are serialized via a
// promise-chain mutex below. Cross-instance is impossible because each
// MM Agent owns a distinct ENS subname.

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
import type { TradeRecord } from "@parley/shared";

import { fetchIndexBlob, uploadJsonBlob, type MmRecordIndex } from "./storage.js";

const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const REGISTRY_ABI = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
]);
const RESOLVER_ABI = parseAbi([
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
]);

export interface ReputationPublisherConfig {
  mmEnsName: string;
  rpcUrl: string;
  privateKey: Hex; // MM_EVM — owns the subname after Phase 3 ownership transfer
}

export class ReputationPublisher {
  private readonly publicClient;
  private readonly walletClient;
  private readonly subnode: Hex;
  private resolverAddress: Hex | null = null;
  // Serializes concurrent publish() calls so the read-modify-write against
  // ENS reputation_root can't drop a record under same-instance races.
  private publishLock: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: ReputationPublisherConfig) {
    const account = privateKeyToAccount(cfg.privateKey);
    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain: sepolia, transport });
    this.walletClient = createWalletClient({ chain: sepolia, transport, account });
    this.subnode = namehash(cfg.mmEnsName);
  }

  /** Full publish: upload record → fetch+append cumulative index → upload
   *  new index → set ENS pointer. Returns the three operation hashes for
   *  logging. */
  async publish(record: TradeRecord): Promise<{
    recordHash: string;
    indexHash: string;
    ensTx: Hex;
  }> {
    const previous = this.publishLock;
    let release!: () => void;
    this.publishLock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await previous;

      // 1. Upload TradeRecord.
      const recordHash = await uploadJsonBlob(
        record,
        `record-${record.trade_id.slice(0, 10)}`,
      );

      // 2. Read current cumulative index from ENS. Empty on first-ever
      // publish for this MM (subname has no reputation_root text record yet).
      const records = await this.fetchCurrentRecords();

      // 3. Append idempotently.
      if (!records.includes(recordHash)) records.push(recordHash);

      // 4. Upload new index blob.
      const idx: MmRecordIndex = { records };
      const indexHash = await uploadJsonBlob(idx, "mm-index");

      // 5. Set ENS reputation_root.
      const ensTx = await this.setReputationRoot(indexHash);
      return { recordHash, indexHash, ensTx };
    } finally {
      release();
    }
  }

  /** Fetch the existing index blob via ENS reputation_root. Returns []
   *  if the text record isn't set (first-ever publish). Throws on read
   *  failure — never silently start fresh, because that would orphan
   *  the existing history. */
  private async fetchCurrentRecords(): Promise<string[]> {
    const root = await this.readReputationRoot();
    if (!root) return [];
    const blob = await fetchIndexBlob(root);
    return blob.records.slice(); // defensive copy — we mutate it
  }

  private async readReputationRoot(): Promise<string | null> {
    const resolver = await this.getResolver();
    const value = (await this.publicClient.readContract({
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: "text",
      args: [this.subnode, "reputation_root"],
    })) as string;
    if (!value || !value.startsWith("0x")) return null;
    return value;
  }

  private async setReputationRoot(indexHash: string): Promise<Hex> {
    const resolver = await this.getResolver();
    const account = this.walletClient.account;
    if (!account) throw new Error("wallet client missing account");
    return this.walletClient.writeContract({
      account,
      chain: this.walletClient.chain,
      address: resolver,
      abi: RESOLVER_ABI,
      functionName: "setText",
      args: [this.subnode, "reputation_root", indexHash],
    });
  }

  private async getResolver(): Promise<Hex> {
    if (this.resolverAddress) return this.resolverAddress;
    const r = (await this.publicClient.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "resolver",
      args: [this.subnode],
    })) as Hex;
    if (r === "0x0000000000000000000000000000000000000000") {
      throw new Error(
        `${this.cfg.mmEnsName} has no resolver set on Registry — did register-mm.ts run?`,
      );
    }
    this.resolverAddress = r;
    return r;
  }
}
