// Quote signing, accept handling, settlement submission. SPEC §4.2.
// All EIP-712 signing happens here with the MM hot wallet via viem.

import type { Intent, Offer, DealTerms } from "@parley/shared";

export async function signAndBuildOffer(_intent: Intent): Promise<Offer> {
  // TODO: sign offer payload via privateKeyToAccount(MM_EVM_PRIVATE_KEY)
  throw new Error("not implemented");
}

export async function lockMMSide(_deal: DealTerms): Promise<`0x${string}`> {
  // TODO: walletClient.writeContract({ functionName: "lockMMSide", ... })
  // with exponential backoff (3 attempts, 1s/2s/4s) on receipt fetch.
  throw new Error("not implemented");
}
