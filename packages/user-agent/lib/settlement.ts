// Calldata + EIP-712 typed-data builder for the user-side settlement flow.
// SPEC.md §8.2: this module MUST NOT submit transactions. The Mini App
// consumes the returned structures and submits from the user's own wallet.

import {
  DEAL_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  type DealTerms,
  type Hex,
} from "@parley/shared";

export interface PreparedLockUserSide {
  typedData: {
    domain: typeof PARLEY_EIP712_DOMAIN & { verifyingContract: Hex };
    types: typeof DEAL_EIP712_TYPES;
    primaryType: "Deal";
    message: DealTerms;
  };
  callTarget: {
    address: Hex;
    functionName: "lockUserSide";
  };
  // Mini App appends userSig before submitting.
  argsWithoutSig: [DealTerms];
}

export function prepareLockUserSide(
  deal: DealTerms,
  settlementContract: Hex,
): PreparedLockUserSide {
  return {
    typedData: {
      domain: { ...PARLEY_EIP712_DOMAIN, verifyingContract: settlementContract },
      types: DEAL_EIP712_TYPES,
      primaryType: "Deal",
      message: deal,
    },
    callTarget: {
      address: settlementContract,
      functionName: "lockUserSide",
    },
    argsWithoutSig: [deal],
  };
}

// TODO: prepareSettle, prepareRefund — same shape. (prepareFallbackSwap
// lives in `mcps/og-mcp/src/uniswap.ts` since og-mcp is its only consumer.)
