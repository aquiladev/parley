// 0G Storage adapter for the MM Agent.
//
// Uploads JSON blobs (TradeRecords + per-MM index blobs) to 0G Storage and
// returns root hashes. Read path is owned by og-mcp on the User Agent side
// — the MM doesn't read its own records, just publishes them.
//
// Mirrors packages/user-agent/mcps/og-mcp/src/storage.ts. Same createRequire
// dance for the SDK's CJS/ESM packaging quirk.

import { ethers } from "ethers";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sdk = require("@0gfoundation/0g-ts-sdk") as any;
const { Indexer, ZgFile } = sdk;

const STORAGE_RPC_URL =
  process.env["ZG_STORAGE_RPC_URL"] ?? "https://evmrpc-testnet.0g.ai";
const STORAGE_INDEXER_URL =
  process.env["ZG_STORAGE_INDEXER_URL"] ??
  "https://indexer-storage-testnet-turbo.0g.ai";

let indexerSingleton: InstanceType<typeof Indexer> | null = null;
let signerSingleton: ethers.Wallet | null = null;

function getIndexer(): InstanceType<typeof Indexer> {
  if (indexerSingleton) return indexerSingleton;
  indexerSingleton = new Indexer(STORAGE_INDEXER_URL);
  return indexerSingleton;
}

function getSigner(): ethers.Wallet {
  if (signerSingleton) return signerSingleton;
  const pk = process.env["OG_PRIVATE_KEY"];
  if (!pk) {
    throw new Error(
      "OG_PRIVATE_KEY is required for 0G Storage uploads. Pays for storage in OG tokens — separate from MM_EVM (Sepolia gas).",
    );
  }
  const provider = new ethers.JsonRpcProvider(STORAGE_RPC_URL);
  signerSingleton = new ethers.Wallet(pk, provider);
  return signerSingleton;
}

/** Upload arbitrary JSON-serializable data, return its 0G root hash. */
export async function uploadJsonBlob(data: unknown, label = "blob"): Promise<string> {
  const indexer = getIndexer();
  const signer = getSigner();
  const json = JSON.stringify(data);
  const dir = mkdtempSync(join(tmpdir(), "parley-mm-og-"));
  const path = join(dir, `${label}.json`);
  writeFileSync(path, json);
  try {
    const zgFile = await ZgFile.fromFilePath(path);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [tx, err] = await indexer.upload(zgFile, STORAGE_RPC_URL, signer as any);
      if (err !== null) throw new Error(`upload: ${err}`);
      const rootHash = "rootHash" in tx ? tx.rootHash : tx.rootHashes[0];
      if (!rootHash) throw new Error("upload returned no root hash");
      return rootHash as string;
    } finally {
      await zgFile.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read the local index file. Used to reconstruct the index blob on each
 *  new record so og-mcp's MM-side reads can fetch the canonical history
 *  via the ENS reputation_root pointer. */
export interface MmRecordIndex {
  records: string[]; // chronological list of TradeRecord root hashes
}

export function loadLocalIndex(path: string): MmRecordIndex {
  try {
    const raw = readFileSync(path, "utf-8");
    const j = JSON.parse(raw) as MmRecordIndex;
    if (!Array.isArray(j.records)) return { records: [] };
    return j;
  } catch {
    return { records: [] };
  }
}

export function saveLocalIndex(path: string, idx: MmRecordIndex): void {
  writeFileSync(path, JSON.stringify(idx, null, 2));
}
