/*
 * Single-use enforcement for signed oracle authorizations (#336).
 *
 * Lifecycle of one fingerprint:
 *
 *   (absent) --claim--> in_flight --complete--> consumed   (terminal)
 *                           |  ^
 *                   release |  | claim (retry, or lease expired after a crash)
 *                           v  |
 *                         released
 *
 * Ordering is the security property: an envelope is normalized, checked for
 * expiry and horizon, and its signature verified *before* the store is
 * touched. A forged or malformed request can therefore never burn a
 * legitimate fingerprint, and an expired one is refused without a lookup.
 *
 * Records are pruned only after `expiresAt + retentionGraceSeconds`; since
 * expired envelopes are refused up front, a pruned fingerprint can never be
 * accepted again. See docs/AUTHORIZATION_REPLAY_FINGERPRINTS.md.
 */

import { randomUUID } from "crypto";
import {
  AuthorizationEnvelope,
  AuthorizationFingerprintError,
  authorizationFingerprint,
  canonicalAuthorization,
} from "./authorization-fingerprint";

export type ReplayRecordState = "in_flight" | "released" | "consumed";

export interface ReplayRecord {
  fingerprint: string;
  state: ReplayRecordState;
  /** Unix seconds; the record is kept at least until this plus the grace. */
  expiresAt: number;
  attempts: number;
  /** Identifies the current claimant; stale workers cannot complete. */
  leaseToken: string | null;
  /** Epoch ms after which an in_flight claim is presumed abandoned. */
  leaseExpiresAtMs: number | null;
  lastError: string | null;
  /** Monotonic per-record version for compare-and-set. */
  version: number;
}

/**
 * Persistence for replay records. Implementations must make
 * `compareAndSet` atomic across instances (e.g. `INSERT ... ON CONFLICT DO
 * NOTHING` for creates and `UPDATE ... WHERE version = $expected` for
 * updates), otherwise two instances can both accept one authorization.
 */
export interface ReplayRecordStore {
  get(fingerprint: string): Promise<ReplayRecord | undefined>;
  /** Writes `next` only if the stored version equals `expectedVersion` (`null` = absent). */
  compareAndSet(
    fingerprint: string,
    expectedVersion: number | null,
    next: ReplayRecord,
  ): Promise<boolean>;
  /** Deletes records whose `expiresAt` is strictly before `cutoff` (unix s). */
  deleteExpiredBefore(cutoff: number): Promise<number>;
}

/** Reference store for tests and single-instance deployments. */
export class InMemoryReplayRecordStore implements ReplayRecordStore {
  private readonly records = new Map<string, ReplayRecord>();

  async get(fingerprint: string): Promise<ReplayRecord | undefined> {
    const record = this.records.get(fingerprint);
    return record ? { ...record } : undefined;
  }

  async compareAndSet(
    fingerprint: string,
    expectedVersion: number | null,
    next: ReplayRecord,
  ): Promise<boolean> {
    const current = this.records.get(fingerprint);
    if ((current?.version ?? null) !== expectedVersion) return false;
    this.records.set(fingerprint, { ...next });
    return true;
  }

  async deleteExpiredBefore(cutoff: number): Promise<number> {
    let deleted = 0;
    for (const [fingerprint, record] of this.records)
      if (record.expiresAt < cutoff) {
        this.records.delete(fingerprint);
        deleted++;
      }
    return deleted;
  }

  get size(): number {
    return this.records.size;
  }
}

export type AuthorizationRejectionCode =
  | "MALFORMED"
  | "EXPIRED"
  | "EXPIRY_TOO_FAR"
  | "SIGNATURE_INVALID"
  | "REPLAYED"
  | "IN_FLIGHT"
  | "CONTENTION";

export type AuthorizationDecision =
  | {
      status: "accepted";
      fingerprint: string;
      /** 1 on first use; higher after a release or an abandoned lease. */
      attempt: number;
      leaseToken: string;
    }
  | {
      status: "rejected";
      code: AuthorizationRejectionCode;
      fingerprint: string | null;
      /** True when the same request may succeed later without changes. */
      retryable: boolean;
      message: string;
    };

export type SignatureVerifier = (
  envelope: AuthorizationEnvelope,
  signature: string,
) => boolean | Promise<boolean>;

export interface AuthorizationReplayGuardOptions {
  /** Longest accepted lifetime; bounds how long records must be retained. */
  maxLifetimeSeconds?: number;
  /** How long an in_flight claim blocks other claimants. */
  leaseMs?: number;
  /** Extra retention after expiry to absorb clock skew between instances. */
  retentionGraceSeconds?: number;
  /** Attempts (claims) allowed per fingerprint before it is refused. */
  maxAttempts?: number;
  now?: () => number;
}

export class ReplayLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayLeaseError";
  }
}

const DEFAULTS = {
  maxLifetimeSeconds: 3600,
  leaseMs: 30_000,
  retentionGraceSeconds: 300,
  maxAttempts: 5,
};

/** Bounded number of compare-and-set rounds before reporting contention. */
const MAX_CAS_ROUNDS = 3;

export class AuthorizationReplayGuard {
  private readonly maxLifetimeSeconds: number;
  private readonly leaseMs: number;
  private readonly retentionGraceSeconds: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(
    private readonly store: ReplayRecordStore,
    private readonly verifySignature: SignatureVerifier,
    options: AuthorizationReplayGuardOptions = {},
  ) {
    this.maxLifetimeSeconds = options.maxLifetimeSeconds ?? DEFAULTS.maxLifetimeSeconds;
    this.leaseMs = options.leaseMs ?? DEFAULTS.leaseMs;
    this.retentionGraceSeconds =
      options.retentionGraceSeconds ?? DEFAULTS.retentionGraceSeconds;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.now = options.now ?? Date.now;
  }

  /**
   * Verifies and claims an authorization. On `accepted` the caller performs
   * the authorized work and must then call {@link complete} (success) or
   * {@link release} (transient failure, so a retry can claim it again).
   */
  async claim(
    envelope: AuthorizationEnvelope,
    signature: string,
  ): Promise<AuthorizationDecision> {
    let fingerprint: string;
    let expiresAt: number;
    try {
      expiresAt = canonicalAuthorization(envelope).expiresAt;
      fingerprint = authorizationFingerprint(envelope);
    } catch (error) {
      if (!(error instanceof AuthorizationFingerprintError)) throw error;
      return reject("MALFORMED", null, false, error.message);
    }

    const nowMs = this.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    if (nowSeconds >= expiresAt)
      return reject("EXPIRED", fingerprint, false, "Authorization has expired");
    if (expiresAt - nowSeconds > this.maxLifetimeSeconds)
      return reject(
        "EXPIRY_TOO_FAR",
        fingerprint,
        false,
        `Authorization lifetime exceeds ${this.maxLifetimeSeconds}s`,
      );

    let valid = false;
    try {
      valid = typeof signature === "string" && (await this.verifySignature(envelope, signature));
    } catch {
      valid = false;
    }
    if (!valid)
      return reject("SIGNATURE_INVALID", fingerprint, false, "Signature does not match the signer");

    for (let round = 0; round < MAX_CAS_ROUNDS; round++) {
      const current = await this.store.get(fingerprint);
      if (current?.state === "consumed")
        return reject("REPLAYED", fingerprint, false, "Authorization was already used");
      if (
        current?.state === "in_flight" &&
        current.leaseExpiresAtMs !== null &&
        current.leaseExpiresAtMs > nowMs
      )
        return reject("IN_FLIGHT", fingerprint, true, "Authorization is being processed");
      const attempts = (current?.attempts ?? 0) + 1;
      if (attempts > this.maxAttempts)
        return reject("REPLAYED", fingerprint, false, "Authorization exhausted its retry budget");

      const leaseToken = randomUUID();
      const next: ReplayRecord = {
        fingerprint,
        state: "in_flight",
        expiresAt,
        attempts,
        leaseToken,
        leaseExpiresAtMs: nowMs + this.leaseMs,
        lastError: current?.lastError ?? null,
        version: (current?.version ?? 0) + 1,
      };
      if (await this.store.compareAndSet(fingerprint, current?.version ?? null, next))
        return { status: "accepted", fingerprint, attempt: attempts, leaseToken };
    }
    return reject("CONTENTION", fingerprint, true, "Concurrent claims; retry shortly");
  }

  /** Marks the authorization used. Idempotent for the lease holder. */
  async complete(fingerprint: string, leaseToken: string): Promise<void> {
    await this.transition(fingerprint, leaseToken, (record) => ({
      ...record,
      state: "consumed",
      leaseExpiresAtMs: null,
    }));
  }

  /**
   * Returns a claimed authorization after a transient failure (RPC timeout,
   * DB outage) so the same signed request can be retried.
   */
  async release(fingerprint: string, leaseToken: string, reason: string): Promise<void> {
    await this.transition(fingerprint, leaseToken, (record) => ({
      ...record,
      state: "released",
      leaseToken: null,
      leaseExpiresAtMs: null,
      lastError: reason.slice(0, 500),
    }));
  }

  /** Removes records that can no longer be presented. Safe to run anywhere. */
  async prune(): Promise<number> {
    const cutoff = Math.floor(this.now() / 1000) - this.retentionGraceSeconds;
    return this.store.deleteExpiredBefore(cutoff);
  }

  private async transition(
    fingerprint: string,
    leaseToken: string,
    apply: (record: ReplayRecord) => ReplayRecord,
  ): Promise<void> {
    for (let round = 0; round < MAX_CAS_ROUNDS; round++) {
      const current = await this.store.get(fingerprint);
      if (!current) throw new ReplayLeaseError("No claim exists for this authorization");
      // A retried `complete` after a lost acknowledgement is a no-op.
      if (current.state === "consumed" && current.leaseToken === leaseToken) return;
      if (current.state !== "in_flight" || current.leaseToken !== leaseToken)
        throw new ReplayLeaseError("Lease is no longer held; another attempt owns it");
      const next = { ...apply(current), version: current.version + 1 };
      if (await this.store.compareAndSet(fingerprint, current.version, next)) return;
    }
    throw new ReplayLeaseError("Could not update the replay record under contention");
  }
}

function reject(
  code: AuthorizationRejectionCode,
  fingerprint: string | null,
  retryable: boolean,
  message: string,
): AuthorizationDecision {
  return { status: "rejected", code, fingerprint, retryable, message };
}
