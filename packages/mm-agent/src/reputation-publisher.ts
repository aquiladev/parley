// Reputation publish path for the MM Agent (SPEC §7.2 "robust" option).
//
// On each terminal trade outcome:
//   1. Upload the TradeRecord JSON blob to 0G Storage → record root hash.
//   2. Append to the local index file (~/.parley/mm-records.json by default).
//   3. Upload the new index blob (full record-hash list) → index root hash.
//   4. Set the ENS `reputation_root` text record to the index root hash on
//      the MM's subname (mm-1.parley.eth) via PublicResolver.setText.
//      Phase 3 transferred subname ownership to MM_EVM, so this signs with
//      the MM's hot wallet — no PARLEY_ROOT involvement at runtime.
//
// og-mcp's read_mm_reputation reverses the flow: resolve ENS → fetch index
// blob → fetch each record → score.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

import {
  loadLocalIndex,
  saveLocalIndex,
  uploadJsonBlob,
  type MmRecordIndex,
} from "./storage.js";

const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
const REGISTRY_ABI = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
]);
const RESOLVER_ABI = parseAbi([
  "function setText(bytes32 node, string key, string value)",
]);

export interface ReputationPublisherConfig {
  mmEnsName: string;
  rpcUrl: string;
  privateKey: Hex; // MM_EVM — owns the subname after Phase 3 ownership transfer
  /** Path to the local index file. Defaults to `~/.parley/mm-records.json`. */
  indexPath?: string;
}

export class ReputationPublisher {
  private readonly publicClient;
  private readonly walletClient;
  private readonly subnode: Hex;
  private readonly indexPath: string;
  private resolverAddress: Hex | null = null;

  constructor(private readonly cfg: ReputationPublisherConfig) {
    const account = privateKeyToAccount(cfg.privateKey);
    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain: sepolia, transport });
    this.walletClient = createWalletClient({ chain: sepolia, transport, account });
    this.subnode = namehash(cfg.mmEnsName);
    this.indexPath = cfg.indexPath ?? join(homedir(), ".parley", "mm-records.json");
    mkdirSync(dirname(this.indexPath), { recursive: true });
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({ records: [] }, null, 2));
    }
  }

  /** Full publish: upload record → append + upload index → set ENS pointer.
   *  Returns the three operation hashes for logging. */
  async publish(record: TradeRecord): Promise<{
    recordHash: string;
    indexHash: string;
    ensTx: Hex;
  }> {
    // 1. Upload TradeRecord.
    const recordHash = await uploadJsonBlob(record, `record-${record.trade_id.slice(0, 10)}`);

    // 2. Append + persist locally.
    const idx: MmRecordIndex = loadLocalIndex(this.indexPath);
    if (!idx.records.includes(recordHash)) idx.records.push(recordHash);
    saveLocalIndex(this.indexPath, idx);

    // 3. Upload the new index blob.
    const indexHash = await uploadJsonBlob(idx, "mm-index");

    // 4. Set ENS reputation_root.
    const ensTx = await this.setReputationRoot(indexHash);
    return { recordHash, indexHash, ensTx };
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
