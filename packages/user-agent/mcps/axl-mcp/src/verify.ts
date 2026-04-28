// Privileged-tool validation contract (SPEC §4.3).
//
// Every privileged tool call (broadcast_intent, send_accept) runs four checks
// before any side effect. Failure throws UnauthorizedError with one of:
//   SESSION_INVALID       — session sig missing/expired/recovers wrong wallet
//   INTENT_NOT_AUTHORIZED — action sig missing/recovers wrong wallet
//                           or doesn't match the parameters being acted on
//   MALFORMED_PAYLOAD     — schema validation failed
//   BINDING_MISMATCH      — telegram_user_id ↔ wallet binding inconsistent
//
// The MCP intentionally does not trust Hermes' state — Hermes' SOUL.md tells
// it to call privileged tools correctly, but the tools themselves verify
// every input cryptographically.

import { recoverTypedDataAddress, type Hex } from "viem";
import {
  ACCEPT_AUTHORIZATION_EIP712_TYPES,
  INTENT_AUTHORIZATION_EIP712_TYPES,
  PARLEY_EIP712_DOMAIN,
  SESSION_BINDING_EIP712_TYPES,
  type AcceptAuthorization,
  type IntentAuthorization,
  type SessionBinding,
} from "@parley/shared";

export type UnauthorizedReason =
  | "SESSION_INVALID"
  | "INTENT_NOT_AUTHORIZED"
  | "MALFORMED_PAYLOAD"
  | "BINDING_MISMATCH";

export class UnauthorizedError extends Error {
  constructor(
    public readonly reason: UnauthorizedReason,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "UnauthorizedError";
  }
}

const SESSION_SKEW_SECONDS = 60; // tolerate small clock skew
const ACTION_SIG_MAX_AGE_SECONDS = 300; // action sigs are short-lived

/** Verify the session-binding signature, return the bound wallet. Throws
 *  SESSION_INVALID on any failure. */
export async function verifySession(
  binding: SessionBinding,
  sessionSig: Hex,
): Promise<Hex> {
  const now = Math.floor(Date.now() / 1000);
  if (binding.expires_at + SESSION_SKEW_SECONDS < now) {
    throw new UnauthorizedError("SESSION_INVALID", "session expired");
  }

  let recovered: Hex;
  try {
    recovered = await recoverTypedDataAddress({
      domain: PARLEY_EIP712_DOMAIN,
      types: SESSION_BINDING_EIP712_TYPES,
      primaryType: "SessionBinding",
      message: {
        telegram_user_id: BigInt(binding.telegram_user_id),
        wallet: binding.wallet,
        expires_at: BigInt(binding.expires_at),
      },
      signature: sessionSig,
    });
  } catch (err) {
    throw new UnauthorizedError(
      "SESSION_INVALID",
      `signature recovery failed: ${(err as Error).message}`,
    );
  }

  if (recovered.toLowerCase() !== binding.wallet.toLowerCase()) {
    throw new UnauthorizedError(
      "SESSION_INVALID",
      "session signature does not recover to claimed wallet",
    );
  }
  return recovered;
}

/** Verify an IntentAuthorization. Throws INTENT_NOT_AUTHORIZED on bad sig
 *  or stale issued_at. Returns the recovered signer. */
export async function verifyIntentAuthorization(
  auth: IntentAuthorization,
  authSig: Hex,
  expectedIntentId: string,
): Promise<Hex> {
  if (auth.intent_id !== expectedIntentId) {
    throw new UnauthorizedError(
      "INTENT_NOT_AUTHORIZED",
      `auth intent_id (${auth.intent_id}) does not match request (${expectedIntentId})`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (auth.issued_at + ACTION_SIG_MAX_AGE_SECONDS < now) {
    throw new UnauthorizedError("INTENT_NOT_AUTHORIZED", "intent auth signature is stale");
  }

  try {
    return await recoverTypedDataAddress({
      domain: PARLEY_EIP712_DOMAIN,
      types: INTENT_AUTHORIZATION_EIP712_TYPES,
      primaryType: "IntentAuthorization",
      message: {
        intent_id: auth.intent_id,
        telegram_user_id: BigInt(auth.telegram_user_id),
        issued_at: BigInt(auth.issued_at),
      },
      signature: authSig,
    });
  } catch (err) {
    throw new UnauthorizedError(
      "INTENT_NOT_AUTHORIZED",
      `signature recovery failed: ${(err as Error).message}`,
    );
  }
}

/** Verify an AcceptAuthorization. */
export async function verifyAcceptAuthorization(
  auth: AcceptAuthorization,
  authSig: Hex,
  expectedOfferId: string,
  expectedDealHash: Hex,
): Promise<Hex> {
  if (auth.offer_id !== expectedOfferId) {
    throw new UnauthorizedError(
      "INTENT_NOT_AUTHORIZED",
      `auth offer_id (${auth.offer_id}) does not match request (${expectedOfferId})`,
    );
  }
  if (auth.deal_hash.toLowerCase() !== expectedDealHash.toLowerCase()) {
    throw new UnauthorizedError(
      "INTENT_NOT_AUTHORIZED",
      `auth deal_hash does not match request`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (auth.issued_at + ACTION_SIG_MAX_AGE_SECONDS < now) {
    throw new UnauthorizedError("INTENT_NOT_AUTHORIZED", "accept auth signature is stale");
  }

  try {
    return await recoverTypedDataAddress({
      domain: PARLEY_EIP712_DOMAIN,
      types: ACCEPT_AUTHORIZATION_EIP712_TYPES,
      primaryType: "AcceptAuthorization",
      message: {
        offer_id: auth.offer_id,
        deal_hash: auth.deal_hash,
        telegram_user_id: BigInt(auth.telegram_user_id),
        issued_at: BigInt(auth.issued_at),
      },
      signature: authSig,
    });
  } catch (err) {
    throw new UnauthorizedError(
      "INTENT_NOT_AUTHORIZED",
      `signature recovery failed: ${(err as Error).message}`,
    );
  }
}

/** Both wallets recovered from session + action sigs must match, AND the
 *  Telegram user_id must be consistent across all three claims (binding,
 *  auth payload, and the tool-call parameter). Throws BINDING_MISMATCH. */
export function verifyBinding(opts: {
  sessionWallet: Hex;
  actionWallet: Hex;
  bindingTelegramUserId: string;
  authTelegramUserId: string;
  toolCallTelegramUserId: string;
}): void {
  if (opts.sessionWallet.toLowerCase() !== opts.actionWallet.toLowerCase()) {
    throw new UnauthorizedError(
      "BINDING_MISMATCH",
      "session signer differs from action signer",
    );
  }
  if (
    opts.bindingTelegramUserId !== opts.authTelegramUserId ||
    opts.authTelegramUserId !== opts.toolCallTelegramUserId
  ) {
    throw new UnauthorizedError(
      "BINDING_MISMATCH",
      `telegram_user_id mismatch (binding=${opts.bindingTelegramUserId} auth=${opts.authTelegramUserId} call=${opts.toolCallTelegramUserId})`,
    );
  }
}
