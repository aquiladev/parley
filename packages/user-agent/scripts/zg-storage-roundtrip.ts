// Phase 0 smoke test: upload a random blob to 0G Storage, download it by
// rootHash with Merkle-proof verification enabled, compare bytes.
//
// Establishes that the SDK + Galileo testnet indexer work — the eventual
// reputation flow (TradeRecord blobs) lives on top of the same primitives.
//
// Prereqs:
//   OG_PRIVATE_KEY           — Galileo testnet wallet, holds 0G for upload fees
//   ZG_STORAGE_RPC_URL       — defaults to https://evmrpc-testnet.0g.ai
//   ZG_STORAGE_INDEXER_URL   — defaults to https://indexer-storage-testnet-turbo.0g.ai
//
// Run:
//   pnpm -F @parley/user-agent phase0:zg-storage

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { Indexer, ZgFile } from "@0gfoundation/0g-ts-sdk";

const PRIVATE_KEY = process.env["OG_PRIVATE_KEY"];
const RPC_URL = process.env["ZG_STORAGE_RPC_URL"] ?? "https://evmrpc-testnet.0g.ai";
const INDEXER_URL =
  process.env["ZG_STORAGE_INDEXER_URL"] ?? "https://indexer-storage-testnet-turbo.0g.ai";

if (!PRIVATE_KEY) {
  console.error("OG_PRIVATE_KEY is unset. Put your Galileo testnet wallet PK in .env.");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const indexer = new Indexer(INDEXER_URL);

console.log(`[zg-storage] rpc=${RPC_URL}`);
console.log(`[zg-storage] indexer=${INDEXER_URL}`);
console.log(`[zg-storage] signer=${signer.address}`);

const workDir = mkdtempSync(join(tmpdir(), "parley-zg-storage-"));
const uploadPath = join(workDir, "upload.bin");
const downloadPath = join(workDir, "download.bin");

const payload = randomBytes(1024);
writeFileSync(uploadPath, payload);
const sourceHash = createHash("sha256").update(payload).digest("hex");
console.log(`[zg-storage] payload=${payload.length}B sha256=${sourceHash}`);

try {
  // ---- upload ----
  const zgFile = await ZgFile.fromFilePath(uploadPath);
  let rootHash: string;
  let txHash: string;
  try {
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr !== null) throw new Error(`merkleTree: ${treeErr}`);
    console.log(`[zg-storage] local merkle root=${tree?.rootHash() ?? "<unknown>"}`);

    const startedUp = Date.now();
    // Cast to any: the SDK's signer type was generated against ethers' CJS
    // build; ethers ESM provides the same runtime shape but a distinct type.
    const [tx, uploadErr] = await indexer.upload(
      zgFile,
      RPC_URL,
      signer as any,
    );
    if (uploadErr !== null) throw new Error(`upload: ${uploadErr}`);

    if ("rootHash" in tx) {
      rootHash = tx.rootHash;
      txHash = tx.txHash;
    } else {
      const rh = tx.rootHashes[0];
      const th = tx.txHashes[0];
      if (!rh || !th) throw new Error("upload returned empty hashes array");
      rootHash = rh;
      txHash = th;
    }
    console.log(`[zg-storage] upload ${Date.now() - startedUp}ms tx=${txHash}`);
    console.log(`[zg-storage] rootHash=${rootHash}`);
  } finally {
    await zgFile.close();
  }

  // ---- download with Merkle-proof verification ----
  const startedDl = Date.now();
  const dlErr = await indexer.download(rootHash, downloadPath, true);
  if (dlErr !== null) throw new Error(`download: ${dlErr}`);
  console.log(`[zg-storage] download ${Date.now() - startedDl}ms → ${downloadPath}`);

  // ---- byte-level verify ----
  const downloaded = readFileSync(downloadPath);
  const downloadHash = createHash("sha256").update(downloaded).digest("hex");
  if (downloadHash !== sourceHash) {
    throw new Error(`hash mismatch: src=${sourceHash} dl=${downloadHash}`);
  }
  console.log(`[zg-storage] roundtrip OK — ${downloaded.length}B sha256 match`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
