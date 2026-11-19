/**
 * Expiring capability tokens for sensitive actions (#273).
 *
 * A capability token is a short-lived, single-use proof that the account
 * holder deliberately asked to perform *one* sensitive action, optionally on
 * *one* resource. It is minted from an interactive session (never from an API
 * key), signed with HMAC-SHA256, and consumed by the route it authorizes.
 */

/** Request header that carries the token to a protected route. */
export const CAPABILITY_TOKEN_HEADER = "x-capability-token";

/** Wire prefix; bumping the format version changes this and the signing domain. */
export const CAPABILITY_TOKEN_PREFIX = "cap1";

/** Domain-separation label mixed into every signature. */
export const CAPABILITY_SIGNING_DOMAIN = "trellis.capability-token.v1";

/** Hard ceiling on accepted token length, checked before any parsing. */
export const MAX_CAPABILITY_TOKEN_LENGTH = 1024;

export const DEFAULT_CAPABILITY_TTL_SECONDS = 300;
export const MIN_CAPABILITY_TTL_SECONDS = 30;
export const MAX_CAPABILITY_TTL_SECONDS = 900;

/** Tolerated forward clock skew between replicas for `iat`. */
export const CAPABILITY_CLOCK_SKEW_SECONDS = 30;

/**
 * Actions a capability token can authorize. Values are names from the
 * `SensitiveAction` catalogue (asserted in the spec) so the same name appears
 * in tokens, logs and the audit trail.
 * Adding an action is an explicit decision: append it here and decide whether
 * it is bound to a single resource.
 */
export enum CapabilityAction {
  API_KEY_CREATE = "access.api-key.created",
  API_KEY_REVOKE = "access.api-key.revoked",
}

export interface CapabilityActionPolicy {
  /** When true the token must name the exact resource the route acts on. */
  resourceBound: boolean;
  description: string;
}

export const CAPABILITY_ACTION_POLICIES: Readonly<
  Record<CapabilityAction, CapabilityActionPolicy>
> = Object.freeze({
  [CapabilityAction.API_KEY_CREATE]: {
    resourceBound: false,
    description: "Create a new API key for the caller's account",
  },
  [CapabilityAction.API_KEY_REVOKE]: {
    resourceBound: true,
    description: "Revoke one specific API key owned by the caller",
  },
});

export function isCapabilityAction(value: unknown): value is CapabilityAction {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CAPABILITY_ACTION_POLICIES, value)
  );
}

/** Signed claims carried by a token. Short names keep the token compact. */
export interface CapabilityClaims {
  /** Format version. */
  v: 1;
  /** Id of the signing key, so a rotated key can still verify old tokens. */
  kid: string;
  /** Unique token id; the single-use state is keyed on it. */
  jti: string;
  /** Subject (user id) the token was minted for. */
  sub: string;
  /** The one action it authorizes. */
  act: CapabilityAction;
  /** The one resource it authorizes, or null for unbound actions. */
  res: string | null;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

/** What a protected route requires of the presented token. */
export interface CapabilityRequirement {
  subject: string;
  authType?: string | null;
  action: CapabilityAction;
  resourceId?: string | null;
}

/** A token that passed verification and is reserved for one execution. */
export interface CapabilityClaim {
  claims: CapabilityClaims;
}

/** Stable, machine-readable rejection reasons (logged and asserted in tests). */
export enum CapabilityRejection {
  MISSING = "missing",
  MALFORMED = "malformed",
  BAD_SIGNATURE = "bad-signature",
  UNKNOWN_KEY = "unknown-key",
  EXPIRED = "expired",
  NOT_YET_VALID = "not-yet-valid",
  SUBJECT_MISMATCH = "subject-mismatch",
  ACTION_MISMATCH = "action-mismatch",
  RESOURCE_MISMATCH = "resource-mismatch",
  API_KEY_PRINCIPAL = "api-key-principal",
  SESSION_REVOKED = "session-revoked",
  REVOKED = "revoked",
  CONSUMED = "consumed",
  IN_USE = "in-use",
  STORE_UNAVAILABLE = "store-unavailable",
  SIGNING_UNAVAILABLE = "signing-unavailable",
}

/**
 * Environment flag that makes the token mandatory on protected routes. Read
 * per request so it can be flipped (or rolled back) without a redeploy.
 */
export function isCapabilityTokenEnforced(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.CAPABILITY_TOKENS_ENFORCED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}
