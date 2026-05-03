// 0G Storage adapter for the MM Agent.
//
// Uploads JSON blobs (TradeRecords + per-MM index blobs) to 0G Storage and
// returns root hashes. Also reads the MM's own current index blob so the
// publisher can do read-modify-write against ENS reputation_root (otherwise
// a container restart with no local persistence would orphan history).
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

// Two MM Agents share OG_PRIVATE_KEY (Phase 7 — single shared 0G payment
// wallet). One nonce sequence per address means concurrent publishes from
// mm-1 and mm-2 (and the 2-tx record+index publish even from a single MM)
// can collide. The 0G testnet RPC then returns "replacement transaction
// underpriced" / "nonce too low". Wait for the in-flight tx to confirm and
// retry with a fresh nonce — ethers Wallet auto-fetches `pending` count.
const NONCE_RETRY_DELAYS_MS = [8000, 15000, 25000];

function isNonceCollision(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? "";
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    code === "REPLACEMENT_UNDERPRICED" ||
    code === "NONCE_EXPIRED" ||
    msg.includes("replacement transaction underpriced") ||
    msg.includes("replacement fee too low") ||
    msg.includes("nonce too low") ||
    msg.includes("nonce has already been used")
  );
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
    for (let attempt = 0; attempt <= NONCE_RETRY_DELAYS_MS.length; attempt++) {
      const zgFile = await ZgFile.fromFilePath(path);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [tx, err] = await indexer.upload(zgFile, STORAGE_RPC_URL, signer as any);
        if (err !== null) {
          const wrapped = new Error(`upload: ${err}`);
          if (isNonceCollision(err) && attempt < NONCE_RETRY_DELAYS_MS.length) {
            const delay = NONCE_RETRY_DELAYS_MS[attempt]!;
            process.stderr.write(
              `[og-storage] ${label} nonce collision (attempt ${attempt + 1}); retry in ${delay}ms\n`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw wrapped;
        }
        const rootHash = "rootHash" in tx ? tx.rootHash : tx.rootHashes[0];
        if (!rootHash) throw new Error("upload returned no root hash");
        return rootHash as string;
      } finally {
        await zgFile.close();
      }
    }
    throw new Error(`upload: ${label} exhausted nonce-collision retries`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Shape of the MM's reputation index blob — a chronological list of
 *  TradeRecord root hashes. ENS `reputation_root` text record points at
 *  one of these. */
export interface MmRecordIndex {
  records: string[];
}

/** Download an MM index blob by 0G root hash. Used by the publisher to
 *  read its OWN current index off ENS before appending a new record, so
 *  history survives container restarts (no local cache at all). */
export async function fetchIndexBlob(rootHash: string): Promise<MmRecordIndex> {
  const indexer = getIndexer();
  const dir = mkdtempSync(join(tmpdir(), "parley-mm-og-dl-"));
  const path = join(dir, "index.json");
  try {
    const err = await indexer.download(rootHash, path, true);
    if (err !== null) {
      throw new Error(`download: ${err}`);
    }
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as MmRecordIndex).records)
    ) {
      return parsed as MmRecordIndex;
    }
    throw new Error(`index blob ${rootHash} has no "records" array`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
