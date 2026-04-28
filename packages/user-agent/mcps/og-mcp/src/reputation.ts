// SPEC §7.3 — reputation scores computed on demand from TradeRecord blobs.
// Bayesian-smoothed; bounded in [-0.5, 1.0]. Fresh accounts default to 0.0.

import type { TradeRecord } from "@parley/shared";

export const SMOOTHING = 5;
export const FAILED_ACCEPT_WEIGHT = 0.5;
export const MM_TIMEOUT_WEIGHT = 0.5;

export interface UserStats {
  settlements: number;
  failed_acceptances: number;
}

export interface MMStats {
  settlements: number;
  mm_timeouts: number;
}

export function computeUserScore(s: UserStats): number {
  const denom = s.settlements + s.failed_acceptances + SMOOTHING;
  return (s.settlements - FAILED_ACCEPT_WEIGHT * s.failed_acceptances) / denom;
}

export function computeMMScore(s: MMStats): number {
  const denom = s.settlements + s.mm_timeouts + SMOOTHING;
  return (s.settlements - MM_TIMEOUT_WEIGHT * s.mm_timeouts) / denom;
}

/** Aggregate a list of TradeRecords into the stats counters used by
 *  computeUserScore (the records' user_agent matches the queried wallet). */
export function tallyUserStats(records: TradeRecord[]): UserStats {
  let settlements = 0;
  let failed_acceptances = 0;
  for (const r of records) {
    if (r.settled) {
      settlements++;
    } else if (r.defaulted === "user") {
      // User accepted the offer but never signed lockUserSide before deadline.
      failed_acceptances++;
    }
    // SPEC §7.3: on-chain reverts (e.g. insufficient approval) NOT counted —
    // the signal is ambiguous. `defaulted` should never be set to "user" for
    // those cases by the writer.
  }
  return { settlements, failed_acceptances };
}

/** Aggregate records where the queried ENS / wallet is the MM. */
export function tallyMMStats(records: TradeRecord[]): MMStats {
  let settlements = 0;
  let mm_timeouts = 0;
  for (const r of records) {
    if (r.settled) {
      settlements++;
    } else if (r.defaulted === "mm" || r.defaulted === "timeout") {
      // MM accepted offer but never submitted lockMMSide before deadline.
      // "timeout" is recorded when the deadline passed with one or both
      // sides not yet locked — counts against the MM if user_locked && !mm_locked.
      if (r.user_locked && !r.mm_locked) mm_timeouts++;
    }
  }
  return { settlements, mm_timeouts };
}
