/*
 * Replay-safe fingerprints for signed oracle authorization payloads (#336).
 *
 * The fingerprint is the replay key of an EIP-712 oracle authorization. It
 * commits to everything the signer *authorized* — the signing domain (name,
 * version, chain, verifying contract), the signer, the payload type and hash,
 * the nonce and the expiry — over canonical JSON under a versioned schema, so
 * it is reproducible across processes, instances and Node versions.
 *
 * Deliberately excluded: the signature itself. ECDSA signatures are malleable
 * (high-s / low-s, 64- vs 65-byte encodings, v = 0/1 vs 27/28), so a replay
 * key derived from signature bytes can be bypassed by re-encoding the same
 * authorization. Two different encodings of one authorization therefore share
 * one fingerprint, and only one of them can ever be consumed.
 *
 * A fingerprint is not a credential: the replay guard verifies the signature
 * before it records anything. See docs/AUTHORIZATION_REPLAY_FINGERPRINTS.md.
 */

import { createHash } from "crypto";
import { getAddress } from "ethers";
import { canonicalJson } from "../../../common/serialization/canonical-json";

/** Format id embedded in every fingerprint; bump it for any format change. */
export const AUTHORIZATION_FINGERPRINT_SCHEMA =
  "trellis.oracle.authorization-fingerprint.v1";

/** The EIP-712 domain an authorization was signed under. */
export interface AuthorizationDomain {
  name: string;
  version: string;
  chainId: number | string | bigint;
  verifyingContract: string;
}

/** Everything a signer committed to, minus the signature bytes. */
export interface AuthorizationEnvelope {
  domain: AuthorizationDomain;
  signer: string;
  payloadType: string;
  payloadHash: string;
  nonce: string | number | bigint;
  /** Unix seconds after which the authorization is no longer valid. */
  expiresAt: number | string | bigint;
}

/** The normalized form actually hashed; exposed so callers can log it. */
export interface CanonicalAuthorization {
  schema: typeof AUTHORIZATION_FINGERPRINT_SCHEMA;
  domain: {
    name: string;
    version: string;
    chainId: string;
    verifyingContract: string;
  };
  signer: string;
  payloadType: string;
  payloadHash: string;
  nonce: string;
  expiresAt: number;
}

/** Input that cannot be fingerprinted. Never retryable: the bytes are wrong. */
export class AuthorizationFingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationFingerprintError";
  }
}

const BYTES32 = /^0x[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;

function unsignedInteger(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new AuthorizationFingerprintError(`${label} must be nonnegative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new AuthorizationFingerprintError(`${label} must be a nonnegative safe integer`);
    return BigInt(value);
  }
  if (typeof value === "string") {
    // Leading zeros are rejected rather than stripped so "07" and "7" cannot
    // be presented as two different nonces by a client that hashes strings.
    if (!UNSIGNED_DECIMAL.test(value))
      throw new AuthorizationFingerprintError(`${label} must be a canonical unsigned decimal`);
    return BigInt(value);
  }
  throw new AuthorizationFingerprintError(`${label} must be an integer`);
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new AuthorizationFingerprintError(`${label} must be an address`);
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new AuthorizationFingerprintError(`${label} is not a valid address`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new AuthorizationFingerprintError(`${label} must be a nonempty string`);
  return value;
}

/**
 * Normalizes an envelope the same way {@link PayloadSigningService} builds
 * the signed value: payload types are trimmed and lowercased, addresses are
 * compared case-insensitively, and hashes are lowercase 0x-prefixed bytes32.
 */
export function canonicalAuthorization(
  envelope: AuthorizationEnvelope,
): CanonicalAuthorization {
  if (!envelope || typeof envelope !== "object" || !envelope.domain)
    throw new AuthorizationFingerprintError("Authorization envelope is required");
  const payloadHash = text(envelope.payloadHash, "payloadHash").toLowerCase();
  if (!BYTES32.test(payloadHash))
    throw new AuthorizationFingerprintError("payloadHash must be a 0x-prefixed bytes32 hex string");
  const expiresAt = unsignedInteger(envelope.expiresAt, "expiresAt");
  if (expiresAt > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AuthorizationFingerprintError("expiresAt is out of range");

  return {
    schema: AUTHORIZATION_FINGERPRINT_SCHEMA,
    domain: {
      name: text(envelope.domain.name, "domain.name"),
      version: text(envelope.domain.version, "domain.version"),
      chainId: unsignedInteger(envelope.domain.chainId, "domain.chainId").toString(),
      verifyingContract: address(
        envelope.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    signer: address(envelope.signer, "signer"),
    payloadType: text(envelope.payloadType, "payloadType").trim().toLowerCase(),
    payloadHash,
    nonce: unsignedInteger(envelope.nonce, "nonce").toString(),
    expiresAt: Number(expiresAt),
  };
}

/** The exact bytes a fingerprint commits to. */
export function authorizationFingerprintDocument(
  envelope: AuthorizationEnvelope,
): string {
  return canonicalJson(canonicalAuthorization(envelope));
}

/** sha256 hex over {@link authorizationFingerprintDocument}. */
export function authorizationFingerprint(envelope: AuthorizationEnvelope): string {
  return createHash("sha256")
    .update(authorizationFingerprintDocument(envelope))
    .digest("hex");
}
