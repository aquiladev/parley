// 0G Storage adapter for TradeRecord blobs (SPEC §7.2).
//
// Two operations: upload(record) → root_hash, fetch(root_hash) → record.
// Indexer download verifies the Merkle proof against the indexer's commitment
// when withProof=true.
//
// The 0G storage SDK is CJS-only at module-top-level; load via createRequire
// to avoid the same ESM-stub bug we hit with @0glabs/0g-serving-broker (see
// `zg_compute_findings` memory).

import { ethers } from "ethers";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { TradeRecord } from "@parley/shared";

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
function getIndexer(): InstanceType<typeof Indexer> {
  if (indexerSingleton) return indexerSingleton;
  indexerSingleton = new Indexer(STORAGE_INDEXER_URL);
  return indexerSingleton;
}

let signerSingleton: ethers.Wallet | null = null;
function getSigner(): ethers.Wallet {
  if (signerSingleton) return signerSingleton;
  const pk = process.env["OG_PRIVATE_KEY"];
  if (!pk) {
    throw new Error(
      "OG_PRIVATE_KEY is required for 0G Storage uploads (separate from MM_EVM and PARLEY_ROOT — pays in OG tokens, not Sepolia gas).",
    );
  }
  const provider = new ethers.JsonRpcProvider(STORAGE_RPC_URL);
  signerSingleton = new ethers.Wallet(pk, provider);
  return signerSingleton;
}

/** Upload a TradeRecord, return its root hash. */
export async function uploadTradeRecord(record: TradeRecord): Promise<string> {
  const indexer = getIndexer();
  const signer = getSigner();
  const json = JSON.stringify(record);
  const bytes = new TextEncoder().encode(json);

  // ZgFile.fromFilePath wants a real file. Write a temp file (rather than
  // wrestle with MemData typings — the SDK's blob path has been finicky).
  const dir = mkdtempSync(join(tmpdir(), "parley-og-"));
  const path = join(dir, `${record.trade_id}.json`);
  writeFileSync(path, bytes);
  try {
    const zgFile = await ZgFile.fromFilePath(path);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [tx, err] = await indexer.upload(zgFile, STORAGE_RPC_URL, signer as any);
      if (err !== null) {
        throw new Error(`upload: ${err}`);
      }
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

/** Download a TradeRecord by its root hash, verify Merkle proof. */
export async function fetchTradeRecord(rootHash: string): Promise<TradeRecord> {
  return fetchJsonBlob<TradeRecord>(rootHash);
}

/** Download an MM index blob ({ records: rootHash[] }) by root hash. The
 *  reputation_root ENS text record points at one of these. */
export interface MmIndexBlob {
  records: string[];
}
export async function fetchMmIndexBlob(rootHash: string): Promise<MmIndexBlob> {
  const j = await fetchJsonBlob<unknown>(rootHash);
  if (j && typeof j === "object" && Array.isArray((j as MmIndexBlob).records)) {
    return j as MmIndexBlob;
  }
  throw new Error(`index blob ${rootHash} has no "records" array`);
}

async function fetchJsonBlob<T>(rootHash: string): Promise<T> {
  const indexer = getIndexer();
  const dir = mkdtempSync(join(tmpdir(), "parley-og-dl-"));
  const path = join(dir, "blob");
  try {
    const err = await indexer.download(rootHash, path, true);
    if (err !== null) {
      throw new Error(`download: ${err}`);
    }
    const bytes = readFileSync(path);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sanity hash of a TradeRecord, used for local dedup before upload. */
export function recordHash(record: TradeRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
