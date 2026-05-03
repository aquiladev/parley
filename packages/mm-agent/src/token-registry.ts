// Phase 10: per-MM token + pair allowlist with per-pair spread overrides.
//
// Operator env config (all parsed at boot):
//
//   MM_TOKEN_ADDRESSES=USDC:0x1c7d...:6,WETH:0xfff9...:18,UNI:0x1789F...:18
//     SYMBOL:address:decimals tuples, comma-separated. The symbol is just a
//     human label used to cross-reference pair config and reserve env vars;
//     the address (lowercased) is the canonical key everywhere downstream.
//
//   MM_SUPPORTED_PAIRS=USDC/WETH,USDC/UNI,WETH/UNI
//     Pairs the MM is willing to quote. Symbols must appear in
//     MM_TOKEN_ADDRESSES. Pairs are unordered — `USDC/WETH` covers both
//     USDC→WETH and WETH→USDC user intents.
//
//   MM_SPREAD_BPS=20
//     Default spread applied when no pair-specific override exists.
//
//   MM_SPREAD_BPS_<SYM_A>_<SYM_B>=10
//     Per-pair spread override. Symbol order doesn't matter — both
//     MM_SPREAD_BPS_USDC_WETH and MM_SPREAD_BPS_WETH_USDC are honored.
//
//   MM_MIN_<SYMBOL>_RESERVE=0
//     Per-token reserve floor in HUMAN units (e.g., "100" = 100 USDC).
//     Defaults to 0. The MM won't size offers that would push that token
//     below this floor.

import type { Hex } from "viem";

export interface SupportedToken {
  address: Hex; // canonical lowercase
  symbol: string; // operator label, used only for env lookup + logging
  decimals: number;
}

interface ParsedSupportedPair {
  // Stored sorted by address (ascending hex) so the same pair always
  // produces the same key regardless of operator ordering. Direction is
  // tracked separately at quote time.
  tokenA: Hex;
  tokenB: Hex;
}

export interface MmTokenRegistry {
  /** All tokens this MM is configured to handle. Address-keyed (lowercase). */
  tokens: ReadonlyMap<Hex, SupportedToken>;
  /** Default spread applied when no pair-specific override exists. */
  defaultSpreadBps: number;

  /** True when both addresses are supported tokens AND the (unordered)
   *  pair is in the allowlist. */
  isSupportedPair(a: Hex, b: Hex): boolean;
  /** Spread bps to apply for an intent in the (tokenIn, tokenOut)
   *  direction. Falls back to `defaultSpreadBps`. */
  getSpreadBps(tokenIn: Hex, tokenOut: Hex): number;
  /** Look up token info by address (lowercase). Returns undefined for
   *  tokens not in the operator's config. */
  getToken(addr: Hex): SupportedToken | undefined;
  /** All supported pairs as a flat list — used by uniswap-reference's
   *  background refresher and by the ENS agent_capabilities sync. */
  listPairs(): readonly ParsedSupportedPair[];
  /** All supported intent DIRECTIONS (each pair appears twice, once per
   *  direction). The reference cache and per-pair spread lookup work
   *  per-direction. */
  listDirections(): readonly { tokenIn: Hex; tokenOut: Hex }[];
}

interface RegistryConfig {
  tokenAddresses: string | undefined; // raw env value
  supportedPairs: string | undefined;
  defaultSpreadBps: number;
  /** All `MM_SPREAD_BPS_*` env vars at parse time. Pre-loaded by caller
   *  so this module stays test-friendly (no direct process.env reads). */
  spreadOverrides: Record<string, string>;
}

const lc = (s: string): Hex => s.toLowerCase() as Hex;

function parseTokens(raw: string | undefined): Map<Hex, SupportedToken> {
  const out = new Map<Hex, SupportedToken>();
  if (!raw || raw.trim() === "") return out;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(":");
    if (parts.length !== 3) {
      throw new Error(
        `MM_TOKEN_ADDRESSES: malformed entry "${trimmed}" — expected SYMBOL:address:decimals`,
      );
    }
    const [symbol, address, decimalsStr] = parts as [string, string, string];
    const decimals = Number(decimalsStr);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
      throw new Error(
        `MM_TOKEN_ADDRESSES: bad decimals "${decimalsStr}" for ${symbol}`,
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(
        `MM_TOKEN_ADDRESSES: bad address "${address}" for ${symbol}`,
      );
    }
    const addr = lc(address);
    if (out.has(addr)) {
      throw new Error(`MM_TOKEN_ADDRESSES: duplicate address ${addr}`);
    }
    out.set(addr, { address: addr, symbol: symbol.trim(), decimals });
  }
  return out;
}

function parsePairs(
  raw: string | undefined,
  symbolToAddr: Map<string, Hex>,
): ParsedSupportedPair[] {
  if (!raw || raw.trim() === "") return [];
  const out: ParsedSupportedPair[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const slashParts = trimmed.split("/");
    if (slashParts.length !== 2) {
      throw new Error(
        `MM_SUPPORTED_PAIRS: malformed entry "${trimmed}" — expected SYMBOL/SYMBOL`,
      );
    }
    const [symA, symB] = slashParts as [string, string];
    const addrA = symbolToAddr.get(symA.trim().toUpperCase());
    const addrB = symbolToAddr.get(symB.trim().toUpperCase());
    if (!addrA) {
      throw new Error(
        `MM_SUPPORTED_PAIRS: unknown symbol "${symA}" — not in MM_TOKEN_ADDRESSES`,
      );
    }
    if (!addrB) {
      throw new Error(
        `MM_SUPPORTED_PAIRS: unknown symbol "${symB}" — not in MM_TOKEN_ADDRESSES`,
      );
    }
    if (addrA === addrB) {
      throw new Error(`MM_SUPPORTED_PAIRS: same-token pair "${trimmed}"`);
    }
    // Sort by address so canonical key is stable.
    const [tokenA, tokenB] = addrA < addrB ? [addrA, addrB] : [addrB, addrA];
    const key = `${tokenA}/${tokenB}`;
    if (seen.has(key)) continue; // dedupe; not an error, just operator typo
    seen.add(key);
    out.push({ tokenA, tokenB });
  }
  return out;
}

function buildSpreadIndex(
  overrides: Record<string, string>,
  symbolToAddr: Map<string, Hex>,
): Map<string, number> {
  // Key = sorted-address pair `${addrLow}/${addrHigh}`. Per-pair spread
  // applies regardless of direction (USDC→WETH uses the same spread as
  // WETH→USDC; the pair is the unit of pricing).
  const out = new Map<string, number>();
  const prefix = "MM_SPREAD_BPS_";
  for (const [envKey, raw] of Object.entries(overrides)) {
    if (!envKey.startsWith(prefix)) continue;
    const suffix = envKey.slice(prefix.length); // e.g. "USDC_WETH"
    const parts = suffix.split("_");
    if (parts.length !== 2) {
      // Allow longer chains like USDC_WETH_FOO; ignore — only two-symbol
      // overrides are supported. Could be a future extension.
      continue;
    }
    const [symA, symB] = parts as [string, string];
    const addrA = symbolToAddr.get(symA);
    const addrB = symbolToAddr.get(symB);
    if (!addrA || !addrB) continue; // unknown symbols — silently skip
    const bps = Number(raw);
    if (!Number.isFinite(bps)) {
      throw new Error(`${envKey}: not a number ("${raw}")`);
    }
    const [low, high] = addrA < addrB ? [addrA, addrB] : [addrB, addrA];
    out.set(`${low}/${high}`, bps);
  }
  return out;
}

export function buildRegistry(cfg: RegistryConfig): MmTokenRegistry {
  const tokens = parseTokens(cfg.tokenAddresses);

  // Symbol → address index (uppercased symbol, since env vars and pair
  // strings are typically uppercase).
  const symbolToAddr = new Map<string, Hex>();
  for (const t of tokens.values()) {
    symbolToAddr.set(t.symbol.toUpperCase(), t.address);
  }

  const pairs = parsePairs(cfg.supportedPairs, symbolToAddr);
  const pairKeys = new Set(pairs.map((p) => `${p.tokenA}/${p.tokenB}`));
  const spreadIndex = buildSpreadIndex(cfg.spreadOverrides, symbolToAddr);

  function pairKey(a: Hex, b: Hex): string {
    const al = lc(a);
    const bl = lc(b);
    const [low, high] = al < bl ? [al, bl] : [bl, al];
    return `${low}/${high}`;
  }

  // Pre-compute the directional list once; called per-intent so we want
  // the reads to be O(1).
  const directions: { tokenIn: Hex; tokenOut: Hex }[] = [];
  for (const p of pairs) {
    directions.push({ tokenIn: p.tokenA, tokenOut: p.tokenB });
    directions.push({ tokenIn: p.tokenB, tokenOut: p.tokenA });
  }

  return {
    tokens,
    defaultSpreadBps: cfg.defaultSpreadBps,
    isSupportedPair(a, b) {
      const al = lc(a);
      const bl = lc(b);
      if (!tokens.has(al) || !tokens.has(bl)) return false;
      return pairKeys.has(pairKey(al, bl));
    },
    getSpreadBps(tokenIn, tokenOut) {
      const override = spreadIndex.get(pairKey(tokenIn, tokenOut));
      return override !== undefined ? override : cfg.defaultSpreadBps;
    },
    getToken(addr) {
      return tokens.get(lc(addr));
    },
    listPairs() {
      return pairs;
    },
    listDirections() {
      return directions;
    },
  };
}

/** Convenience: build the registry from process.env. Throws on
 *  malformed config so the MM fails boot loudly rather than silently
 *  declining every intent.
 *
 *  Backward compatibility: when `MM_TOKEN_ADDRESSES` and
 *  `MM_SUPPORTED_PAIRS` are unset, synthesize a USDC/WETH-only registry
 *  from `SEPOLIA_USDC_ADDRESS` + `SEPOLIA_WETH_ADDRESS` (the Phase 1
 *  shape). Existing single-pair deployments keep working without env
 *  changes; new multi-token deployments opt in by setting the new vars.
 */
export function loadRegistryFromEnv(): MmTokenRegistry {
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("MM_SPREAD_BPS_") && v !== undefined) overrides[k] = v;
  }
  const defaultSpread = Number(process.env["MM_SPREAD_BPS"] ?? "20");
  if (!Number.isFinite(defaultSpread)) {
    throw new Error(`MM_SPREAD_BPS: not a number ("${process.env["MM_SPREAD_BPS"]}")`);
  }

  let tokenAddresses = process.env["MM_TOKEN_ADDRESSES"];
  let supportedPairs = process.env["MM_SUPPORTED_PAIRS"];

  if (
    (!tokenAddresses || tokenAddresses.trim() === "") &&
    (!supportedPairs || supportedPairs.trim() === "")
  ) {
    // Phase-1 fallback. Operator hasn't opted into multi-token; build
    // the legacy USDC/WETH registry from the chain-token env vars.
    const usdc = process.env["SEPOLIA_USDC_ADDRESS"] ??
      "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
    const weth = process.env["SEPOLIA_WETH_ADDRESS"] ??
      "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
    tokenAddresses = `USDC:${usdc}:6,WETH:${weth}:18`;
    supportedPairs = "USDC/WETH";
  }

  return buildRegistry({
    tokenAddresses,
    supportedPairs,
    defaultSpreadBps: defaultSpread,
    spreadOverrides: overrides,
  });
}
