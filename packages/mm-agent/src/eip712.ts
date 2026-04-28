// EIP-712 typed-data helpers for the on-chain Deal. Must match
// Settlement.sol's typehash exactly — verified by the Foundry test
// `test_dealHash_matchesOffchainDigest`.

import { hashTypedData, type Hex } from "viem";
import type { DealTerms } from "@parley/shared";

export const DEAL_DOMAIN_NAME = "Parley";
export const DEAL_DOMAIN_VERSION = "1";

export const DEAL_TYPES = {
  Deal: [
    { name: "user", type: "address" },
    { name: "mm", type: "address" },
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "amountA", type: "uint256" },
    { name: "amountB", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface DealEip712 {
  user: Hex;
  mm: Hex;
  tokenA: Hex;
  tokenB: Hex;
  amountA: bigint;
  amountB: bigint;
  deadline: bigint;
  nonce: bigint;
}

/** Convert a wire-format DealTerms (decimal strings) into the bigint form
 *  viem's signTypedData / hashTypedData wants. */
export function dealForSigning(d: DealTerms): DealEip712 {
  return {
    user: d.user,
    mm: d.mm,
    tokenA: d.tokenA,
    tokenB: d.tokenB,
    amountA: BigInt(d.amountA),
    amountB: BigInt(d.amountB),
    deadline: BigInt(d.deadline),
    nonce: BigInt(d.nonce),
  };
}

export function dealHash(
  d: DealEip712,
  settlementContract: Hex,
  chainId: number,
): Hex {
  return hashTypedData({
    domain: {
      name: DEAL_DOMAIN_NAME,
      version: DEAL_DOMAIN_VERSION,
      chainId,
      verifyingContract: settlementContract,
    },
    types: DEAL_TYPES,
    primaryType: "Deal",
    message: d,
  });
}
