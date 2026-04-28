// Per-agent index of TradeRecord root hashes (SPEC §7.2 simple option).
//
// Map<agentKey, rootHash[]> persisted to a JSON file at the path given by
// OG_INDEX_PATH (defaults to ~/.parley/og-index.json). Writes happen on
// every append; restart loads the file at boot. Concurrency model: og-mcp
// is single-process / single-threaded, so a simple "read-modify-write"
// pattern is fine. If we ever add concurrent writers, swap for a real KV.
//
// Agent keys: lowercased wallet address for users, ENS name for MMs (per
// §7.3 — User reputation is keyed by wallet, MM reputation by ENS name).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

const INDEX_PATH =
  process.env["OG_INDEX_PATH"] ?? join(homedir(), ".parley", "og-index.json");

interface IndexFile {
  // key → list of TradeRecord root hashes (chronological append order)
  by_user: Record<string, string[]>;
  by_mm: Record<string, string[]>;
}

let cache: IndexFile | null = null;

function load(): IndexFile {
  if (cache) return cache;
  if (existsSync(INDEX_PATH)) {
    try {
      cache = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as IndexFile;
      // Defensive — if either bucket is missing, repair.
      if (!cache.by_user) cache.by_user = {};
      if (!cache.by_mm) cache.by_mm = {};
      return cache;
    } catch {
      // Corrupted file — start fresh, but don't lose the old one.
      const backup = `${INDEX_PATH}.corrupt-${Date.now()}`;
      writeFileSync(backup, readFileSync(INDEX_PATH));
      process.stderr.write(
        `[og-mcp] index file at ${INDEX_PATH} is corrupted; backed up to ${backup} and starting fresh\n`,
      );
    }
  }
  cache = { by_user: {}, by_mm: {} };
  return cache;
}

function persist(): void {
  if (!cache) return;
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(cache, null, 2));
}

export function appendUserRecord(walletAddress: string, rootHash: string): void {
  const idx = load();
  const key = walletAddress.toLowerCase();
  const list = idx.by_user[key] ?? [];
  if (!list.includes(rootHash)) list.push(rootHash);
  idx.by_user[key] = list;
  persist();
}

export function appendMMRecord(ensName: string, rootHash: string): void {
  const idx = load();
  const list = idx.by_mm[ensName] ?? [];
  if (!list.includes(rootHash)) list.push(rootHash);
  idx.by_mm[ensName] = list;
  persist();
}

export function listUserRecords(walletAddress: string): string[] {
  const idx = load();
  return idx.by_user[walletAddress.toLowerCase()] ?? [];
}

export function listMMRecords(ensName: string): string[] {
  const idx = load();
  return idx.by_mm[ensName] ?? [];
}
