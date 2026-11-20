/*
 * Binds the replay guard (#336) to EIP-712 oracle payload signing without
 * changing the signing format: signatures produced before this change verify
 * and fingerprint exactly as before.
 *
 * The port is structural so PayloadSigningService satisfies it as-is, and so
 * this module does not load the service's own dependencies at runtime.
 */

import type { OracleDomain } from "../services/payload-signing.service";
import { AuthorizationEnvelope } from "./authorization-fingerprint";
import { SignatureVerifier } from "./authorization-replay-guard";

/** The subset of PayloadSigningService the replay guard relies on. */
export interface OracleSigningPort {
  getDomain(): OracleDomain;
  hashPayload(payload: Record<string, unknown>): string;
  verifySignature(
    signature: string,
    payloadType: string,
    payloadHash: string,
    nonce: string,
    expiresAt: number,
    data: Record<string, unknown>,
    expectedSigner: string,
  ): boolean;
}

/** Builds the envelope for a payload signed under the port's domain. */
export function oracleAuthorizationEnvelope(
  signing: Pick<OracleSigningPort, "getDomain">,
  input: {
    signer: string;
    payloadType: string;
    payloadHash: string;
    nonce: string;
    expiresAt: number;
  },
): AuthorizationEnvelope {
  const domain = signing.getDomain();
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    ...input,
  };
}

/**
 * Verifier for one request's `data`. The EIP-712 value signs both the
 * payload hash and the data string, and the fingerprint commits only to the
 * hash, so the hash is recomputed from the data: a request can never pair a
 * fingerprint with data it does not describe.
 */
export function oracleSignatureVerifier(
  signing: OracleSigningPort,
  data: Record<string, unknown>,
): SignatureVerifier {
  return (envelope, signature) => {
    if (signing.hashPayload(data).toLowerCase() !== envelope.payloadHash.toLowerCase())
      return false;
    return signing.verifySignature(
      signature,
      envelope.payloadType,
      envelope.payloadHash,
      String(envelope.nonce),
      Number(envelope.expiresAt),
      data,
      envelope.signer,
    );
  };
}
