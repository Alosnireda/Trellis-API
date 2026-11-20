import { createHash, createHmac, timingSafeEqual } from "crypto";
import {
  CAPABILITY_SIGNING_DOMAIN,
  CAPABILITY_TOKEN_PREFIX,
  CapabilityClaims,
  CapabilityRejection,
  isCapabilityAction,
  MAX_CAPABILITY_TOKEN_LENGTH,
} from "./capability-token.types";

/**
 * Stateless encoding for capability tokens (#273):
 *
 *   cap1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>
 *
 * The HMAC covers the domain label, the prefix and the encoded claims, so a
 * signature from any other HMAC use of the same secret can never verify here.
 * Verification is purely cryptographic; expiry, binding and single-use checks
 * live in the service.
 */

export interface CapabilitySigningKey {
  kid: string;
  secret: string;
}

export interface CapabilityKeyRing {
  /** Key used to sign new tokens; null means minting is unavailable. */
  active: CapabilitySigningKey | null;
  /** Every key accepted for verification (active first). */
  verify: CapabilitySigningKey[];
}

/** Key id derived from the secret, so rotation needs no separate id config. */
export function capabilityKeyId(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

export function buildKeyRing(
  secrets: Array<string | null | undefined>,
): CapabilityKeyRing {
  const seen = new Set<string>();
  const verify: CapabilitySigningKey[] = [];
  for (const raw of secrets) {
    const secret = raw?.trim();
    if (!secret) continue;
    const kid = capabilityKeyId(secret);
    if (seen.has(kid)) continue;
    seen.add(kid);
    verify.push({ kid, secret });
  }
  return { active: verify[0] ?? null, verify };
}

function signatureOf(secret: string, encodedClaims: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${CAPABILITY_SIGNING_DOMAIN}.${CAPABILITY_TOKEN_PREFIX}.`)
    .update(encodedClaims)
    .digest();
}

export function encodeCapabilityToken(
  claims: CapabilityClaims,
  key: CapabilitySigningKey,
): string {
  const encoded = Buffer.from(
    JSON.stringify({ ...claims, kid: key.kid }),
    "utf8",
  ).toString("base64url");
  const signature = signatureOf(key.secret, encoded).toString("base64url");
  return `${CAPABILITY_TOKEN_PREFIX}.${encoded}.${signature}`;
}

export type DecodeResult =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: CapabilityRejection };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isClaims(value: any): value is CapabilityClaims {
  return (
    value !== null &&
    typeof value === "object" &&
    value.v === 1 &&
    typeof value.kid === "string" &&
    typeof value.jti === "string" &&
    value.jti.length > 0 &&
    value.jti.length <= 64 &&
    typeof value.sub === "string" &&
    value.sub.length > 0 &&
    isCapabilityAction(value.act) &&
    (value.res === null ||
      (typeof value.res === "string" && value.res.length <= 256)) &&
    Number.isSafeInteger(value.iat) &&
    Number.isSafeInteger(value.exp) &&
    value.exp > value.iat
  );
}

/**
 * Parses and authenticates a token. The signature is checked against the key
 * named by `kid` *before* the claims are trusted; the claims JSON is only
 * parsed up front to learn the `kid`.
 */
export function decodeCapabilityToken(
  token: unknown,
  ring: CapabilityKeyRing,
): DecodeResult {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CAPABILITY_TOKEN_LENGTH
  ) {
    return { ok: false, reason: CapabilityRejection.MALFORMED };
  }
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== CAPABILITY_TOKEN_PREFIX ||
    !BASE64URL.test(parts[1]) ||
    !BASE64URL.test(parts[2])
  ) {
    return { ok: false, reason: CapabilityRejection.MALFORMED };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: CapabilityRejection.MALFORMED };
  }
  if (!isClaims(parsed)) {
    return { ok: false, reason: CapabilityRejection.MALFORMED };
  }

  const key = ring.verify.find((candidate) => candidate.kid === parsed.kid);
  if (!key) return { ok: false, reason: CapabilityRejection.UNKNOWN_KEY };

  const expected = signatureOf(key.secret, parts[1]);
  const presented = Buffer.from(parts[2], "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return { ok: false, reason: CapabilityRejection.BAD_SIGNATURE };
  }

  return { ok: true, claims: parsed };
}
