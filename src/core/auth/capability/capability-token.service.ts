import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { createHash, createHmac, randomUUID } from "crypto";
import { AppException } from "src/common/errors/app.exception";
import { ErrorCode } from "src/common/errors/error-codes";
import { TokenBlacklistService } from "../token-blacklist.service";
import {
  buildKeyRing,
  CapabilityKeyRing,
  decodeCapabilityToken,
  encodeCapabilityToken,
} from "./capability-token.codec";
import {
  CAPABILITY_TOKEN_STORE,
  CapabilityTokenStore,
} from "./capability-token.store";
import {
  CAPABILITY_STEP_UP_VERIFIER,
  CapabilityStepUpVerifier,
} from "./capability-step-up.verifier";
import {
  CAPABILITY_ACTION_POLICIES,
  CAPABILITY_CLOCK_SKEW_SECONDS,
  CapabilityAction,
  CapabilityClaim,
  CapabilityClaims,
  CapabilityRejection,
  CapabilityRequirement,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  isCapabilityAction,
  MAX_CAPABILITY_TTL_SECONDS,
  MIN_CAPABILITY_TTL_SECONDS,
} from "./capability-token.types";

export const CAPABILITY_TOKEN_OPTIONS = "CAPABILITY_TOKEN_OPTIONS";

export interface CapabilityTokenOptions {
  /** Signing secrets, newest first. Defaults to the environment. */
  secrets?: Array<string | null | undefined>;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  /** Clock in epoch milliseconds (tests). */
  now?: () => number;
}

/** Window a used step-up code stays blocked; covers TOTP's ±1 step skew. */
const STEP_UP_REPLAY_WINDOW_SECONDS = 90;

/**
 * Signing secrets from the environment, newest first:
 *   CAPABILITY_TOKEN_SECRET            signs and verifies
 *   CAPABILITY_TOKEN_PREVIOUS_SECRET   verifies only (rotation overlap)
 * With neither set, a key is derived from JWT_SECRET with a fixed domain
 * label, so the feature works out of the box without sharing the raw JWT key.
 */
export function capabilitySecretsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const explicit = [
    env.CAPABILITY_TOKEN_SECRET,
    env.CAPABILITY_TOKEN_PREVIOUS_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (explicit.length > 0) return explicit;

  const jwtSecret = env.JWT_SECRET?.trim();
  if (!jwtSecret) return [];
  return [
    createHmac("sha256", jwtSecret)
      .update("trellis.capability-token.derived-key.v1")
      .digest("hex"),
  ];
}

export interface MintCapabilityInput {
  principal: { id?: string | null; authType?: string | null };
  action: unknown;
  resourceId?: string | null;
  ttlSeconds?: number | null;
  stepUpCode?: string | null;
}

export interface MintedCapability {
  token: string;
  tokenId: string;
  action: CapabilityAction;
  resourceId: string | null;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds: number;
}

const REJECTIONS: Record<
  CapabilityRejection,
  {
    status: HttpStatus;
    code: ErrorCode;
    message: string;
    guidance: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }
> = {
  [CapabilityRejection.MISSING]: {
    status: HttpStatus.PRECONDITION_REQUIRED,
    code: ErrorCode.PRECONDITION_FAILED,
    message: "This action requires a capability token",
    guidance:
      "Mint a token with POST /auth/capabilities for this action and send it in the X-Capability-Token header.",
  },
  [CapabilityRejection.MALFORMED]: forbidden("is malformed"),
  [CapabilityRejection.BAD_SIGNATURE]: forbidden("signature is invalid"),
  [CapabilityRejection.UNKNOWN_KEY]: forbidden(
    "was signed with a key that is no longer accepted",
  ),
  [CapabilityRejection.NOT_YET_VALID]: forbidden("is not valid yet"),
  [CapabilityRejection.SUBJECT_MISMATCH]: forbidden(
    "was issued to a different account",
  ),
  [CapabilityRejection.ACTION_MISMATCH]: forbidden(
    "does not authorize this action",
  ),
  [CapabilityRejection.RESOURCE_MISMATCH]: forbidden(
    "does not authorize this resource",
  ),
  [CapabilityRejection.API_KEY_PRINCIPAL]: {
    status: HttpStatus.FORBIDDEN,
    code: ErrorCode.FORBIDDEN,
    message:
      "Capability tokens cannot be used or minted with API key authentication",
    guidance: "Perform sensitive actions from an interactive user session.",
  },
  [CapabilityRejection.EXPIRED]: {
    status: HttpStatus.FORBIDDEN,
    code: ErrorCode.TOKEN_EXPIRED,
    message: "Capability token has expired",
    guidance: "Mint a new capability token and retry the action.",
  },
  [CapabilityRejection.SESSION_REVOKED]: {
    status: HttpStatus.UNAUTHORIZED,
    code: ErrorCode.SESSION_TERMINATED,
    message: "Capability token belongs to a session that was revoked",
    guidance: "Sign in again, then mint a new capability token.",
  },
  [CapabilityRejection.REVOKED]: {
    status: HttpStatus.CONFLICT,
    code: ErrorCode.CONFLICT,
    message: "Capability token was revoked",
    guidance: "Mint a new capability token if the action is still intended.",
    retryable: false,
  },
  [CapabilityRejection.CONSUMED]: {
    status: HttpStatus.CONFLICT,
    code: ErrorCode.CONFLICT,
    message: "Capability token has already been used",
    guidance:
      "Capability tokens are single-use. Mint a new token to repeat the action.",
    retryable: false,
  },
  [CapabilityRejection.IN_USE]: {
    status: HttpStatus.CONFLICT,
    code: ErrorCode.CONFLICT,
    message: "Capability token is being used by another request",
    guidance:
      "Wait for the other request to finish. If it fails the token becomes usable again.",
    retryable: true,
    retryAfterSeconds: 1,
  },
  [CapabilityRejection.STORE_UNAVAILABLE]: unavailable(
    "Capability token state is temporarily unavailable",
  ),
  [CapabilityRejection.SIGNING_UNAVAILABLE]: unavailable(
    "Capability tokens are not configured on this server",
  ),
};

function forbidden(detail: string) {
  return {
    status: HttpStatus.FORBIDDEN,
    code: ErrorCode.FORBIDDEN,
    message: `Capability token ${detail}`,
    guidance:
      "Mint a new capability token for this exact action and resource and retry.",
  };
}

function unavailable(message: string) {
  return {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message,
    guidance:
      "Retry shortly. Sensitive actions fail closed while this persists.",
    retryable: true,
    retryAfterSeconds: 5,
  };
}

/** Exception carrying the stable rejection reason for logs and tests. */
export class CapabilityTokenException extends AppException {
  constructor(public readonly reason: CapabilityRejection) {
    const spec = REJECTIONS[reason];
    super(spec.message, spec.status, spec.code, {
      recoveryGuidance: spec.guidance,
      retryable: spec.retryable ?? false,
      retryAfterSeconds: spec.retryAfterSeconds,
    });
  }
}

/**
 * Mints, verifies and consumes capability tokens (#273).
 *
 * Lifecycle of one token:
 *
 *   mint ──► valid ──claim──► reserved ──success──► consumed (terminal)
 *              │                 │
 *              │                 └──handler error──► valid again (retry)
 *              ├──revoke / session revoked──► rejected
 *              └──exp passes──► expired (rejected by signature check)
 *
 * Failure posture: every uncertainty denies. An unreachable store rejects
 * with 503; a failed release or commit leaves the token reserved until it
 * expires, which can only make it unusable, never reusable.
 */
@Injectable()
export class CapabilityTokenService {
  private readonly logger = new Logger(CapabilityTokenService.name);
  private readonly ring: CapabilityKeyRing;
  private readonly defaultTtl: number;
  private readonly maxTtl: number;
  private readonly now: () => number;

  constructor(
    @Inject(CAPABILITY_TOKEN_STORE)
    private readonly store: CapabilityTokenStore,
    @Inject(CAPABILITY_STEP_UP_VERIFIER)
    private readonly stepUp: CapabilityStepUpVerifier,
    private readonly sessions: TokenBlacklistService,
    @Optional()
    @Inject(CAPABILITY_TOKEN_OPTIONS)
    options: CapabilityTokenOptions | null = null,
  ) {
    this.ring = buildKeyRing(options?.secrets ?? capabilitySecretsFromEnv());
    this.maxTtl = clamp(
      options?.maxTtlSeconds ?? MAX_CAPABILITY_TTL_SECONDS,
      MIN_CAPABILITY_TTL_SECONDS,
      MAX_CAPABILITY_TTL_SECONDS,
    );
    this.defaultTtl = clamp(
      options?.defaultTtlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS,
      MIN_CAPABILITY_TTL_SECONDS,
      this.maxTtl,
    );
    this.now = options?.now ?? Date.now;
    if (!this.ring.active) {
      this.logger.error(
        "No capability token secret configured (CAPABILITY_TOKEN_SECRET or JWT_SECRET); " +
          "minting and verification will fail closed",
      );
    }
  }

  /** Mints a token for one action (and resource) after the step-up check. */
  async mint(input: MintCapabilityInput): Promise<MintedCapability> {
    const subject = input.principal?.id;
    if (!subject) {
      throw new AppException(
        "An authenticated user account is required",
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
      );
    }
    if (input.principal.authType === "api-key") {
      this.rejected(CapabilityRejection.API_KEY_PRINCIPAL, { sub: subject });
    }
    if (!isCapabilityAction(input.action)) {
      throw new AppException(
        `Unsupported capability action: ${String(input.action).slice(0, 64)}`,
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_PARAMETER,
      );
    }
    const action = input.action;
    const resourceId = normaliseResource(input.resourceId);
    const policy = CAPABILITY_ACTION_POLICIES[action];
    if (policy.resourceBound && resourceId === null) {
      throw new AppException(
        `${action} requires a resourceId`,
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_PARAMETER,
      );
    }
    if (!policy.resourceBound && resourceId !== null) {
      throw new AppException(
        `${action} is not bound to a resource; omit resourceId`,
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_PARAMETER,
      );
    }
    const ttlSeconds = this.resolveTtl(input.ttlSeconds);
    if (!this.ring.active) {
      this.rejected(CapabilityRejection.SIGNING_UNAVAILABLE, { sub: subject });
    }

    await this.checkStepUp(subject, input.stepUpCode);

    const iat = Math.floor(this.now() / 1000);
    const claims: CapabilityClaims = {
      v: 1,
      kid: this.ring.active.kid,
      jti: randomUUID(),
      sub: subject,
      act: action,
      res: resourceId,
      iat,
      exp: iat + ttlSeconds,
    };
    const token = encodeCapabilityToken(claims, this.ring.active);
    this.logger.log({
      event: "capability.minted",
      jti: claims.jti,
      sub: subject,
      act: action,
      res: resourceId,
      exp: claims.exp,
    });
    return {
      token,
      tokenId: claims.jti,
      action,
      resourceId,
      issuedAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      ttlSeconds,
    };
  }

  /**
   * Verifies `token` against what the route requires and reserves it for
   * this execution. The caller must follow with exactly one of
   * {@link commit} (success) or {@link release} (failure).
   */
  async claim(
    token: string | null | undefined,
    requirement: CapabilityRequirement,
  ): Promise<CapabilityClaim> {
    if (token === null || token === undefined || token === "") {
      this.rejected(CapabilityRejection.MISSING, requirement);
    }
    const claims = this.verify(token, requirement);

    let stale: boolean;
    try {
      stale = await this.sessions.isSessionStale(claims.sub, claims.iat);
    } catch {
      this.rejected(CapabilityRejection.STORE_UNAVAILABLE, claims);
    }
    if (stale) this.rejected(CapabilityRejection.SESSION_REVOKED, claims);

    const ttl = this.remainingTtl(claims);
    let reserved: boolean;
    try {
      if (await this.store.isRevoked(claims.jti)) {
        this.rejected(CapabilityRejection.REVOKED, claims);
      }
      reserved = await this.store.reserve(claims.jti, ttl);
      if (!reserved) {
        const state = await this.store.state(claims.jti);
        this.rejected(
          state === "consumed"
            ? CapabilityRejection.CONSUMED
            : CapabilityRejection.IN_USE,
          claims,
        );
      }
    } catch (error) {
      if (error instanceof CapabilityTokenException) throw error;
      this.logger.error({
        event: "capability.store-error",
        jti: claims.jti,
        error: error instanceof Error ? error.message : String(error),
      });
      this.rejected(CapabilityRejection.STORE_UNAVAILABLE, claims);
    }

    this.logger.log({
      event: "capability.reserved",
      jti: claims.jti,
      act: claims.act,
    });
    return { claims };
  }

  /** Marks a claimed token consumed after the action succeeded. Never throws. */
  async commit(claim: CapabilityClaim): Promise<void> {
    try {
      await this.store.consume(
        claim.claims.jti,
        this.remainingTtl(claim.claims),
      );
      this.logger.log({
        event: "capability.consumed",
        jti: claim.claims.jti,
        sub: claim.claims.sub,
        act: claim.claims.act,
        res: claim.claims.res,
      });
    } catch (error) {
      // The reservation still blocks reuse until the token expires.
      this.logger.error({
        event: "capability.commit-failed",
        jti: claim.claims.jti,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Returns a claimed token to the usable state after a failure. Never throws. */
  async release(claim: CapabilityClaim): Promise<void> {
    try {
      await this.store.release(claim.claims.jti);
      this.logger.log({ event: "capability.released", jti: claim.claims.jti });
    } catch (error) {
      // Safe direction: the token stays reserved and the caller must mint anew.
      this.logger.error({
        event: "capability.release-failed",
        jti: claim.claims.jti,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Runs `operation` under a capability token: claim, run, then commit on
   * success or release on failure (rethrowing the original error). For
   * callers outside the HTTP interceptor.
   */
  async execute<T>(
    token: string | null | undefined,
    requirement: CapabilityRequirement,
    operation: () => Promise<T>,
  ): Promise<T> {
    const claim = await this.claim(token, requirement);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await this.release(claim);
      throw error;
    }
    await this.commit(claim);
    return result;
  }

  /**
   * Revokes an unused token. Only its owner may revoke it; revoking an
   * expired or already-revoked token is a successful no-op.
   */
  async revoke(
    token: string,
    principal: { id?: string | null; authType?: string | null },
  ): Promise<{ tokenId: string; revoked: true; expired: boolean }> {
    if (!principal?.id) {
      throw new AppException(
        "An authenticated user account is required",
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
      );
    }
    const decoded = decodeCapabilityToken(token, this.ring);
    if (decoded.ok === false)
      this.rejected(decoded.reason, { sub: principal.id });
    const claims = decoded.claims;
    if (claims.sub !== principal.id) {
      this.rejected(CapabilityRejection.SUBJECT_MISMATCH, claims);
    }
    if (this.isExpired(claims)) {
      return { tokenId: claims.jti, revoked: true, expired: true };
    }
    try {
      await this.store.revoke(claims.jti, this.remainingTtl(claims));
    } catch {
      this.rejected(CapabilityRejection.STORE_UNAVAILABLE, claims);
    }
    this.logger.log({
      event: "capability.revoked",
      jti: claims.jti,
      sub: claims.sub,
    });
    return { tokenId: claims.jti, revoked: true, expired: false };
  }

  /** Stateless checks: signature, binding and time window. */
  private verify(
    token: string,
    requirement: CapabilityRequirement,
  ): CapabilityClaims {
    if (requirement.authType === "api-key") {
      this.rejected(CapabilityRejection.API_KEY_PRINCIPAL, requirement);
    }
    if (this.ring.verify.length === 0) {
      this.rejected(CapabilityRejection.SIGNING_UNAVAILABLE, requirement);
    }
    const decoded = decodeCapabilityToken(token, this.ring);
    if (decoded.ok === false) this.rejected(decoded.reason, requirement);
    const claims = decoded.claims;

    if (!requirement.subject || claims.sub !== requirement.subject) {
      this.rejected(CapabilityRejection.SUBJECT_MISMATCH, claims);
    }
    if (claims.act !== requirement.action) {
      this.rejected(CapabilityRejection.ACTION_MISMATCH, claims);
    }
    const expectedResource = CAPABILITY_ACTION_POLICIES[requirement.action]
      .resourceBound
      ? normaliseResource(requirement.resourceId)
      : null;
    if (claims.res !== expectedResource) {
      this.rejected(CapabilityRejection.RESOURCE_MISMATCH, claims);
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    if (claims.iat > nowSeconds + CAPABILITY_CLOCK_SKEW_SECONDS) {
      this.rejected(CapabilityRejection.NOT_YET_VALID, claims);
    }
    if (this.isExpired(claims)) {
      this.rejected(CapabilityRejection.EXPIRED, claims);
    }
    return claims;
  }

  private async checkStepUp(
    subject: string,
    code: string | null | undefined,
  ): Promise<void> {
    if (!(await this.stepUp.isRequired(subject))) return;
    const trimmed = typeof code === "string" ? code.trim() : "";
    if (!trimmed) {
      throw new AppException(
        "This account requires a TOTP code to mint a capability token",
        HttpStatus.PRECONDITION_REQUIRED,
        ErrorCode.PRECONDITION_FAILED,
        {
          recoveryGuidance: "Send a current authenticator code as stepUpCode.",
        },
      );
    }
    if (!(await this.stepUp.verify(subject, trimmed))) {
      throw new AppException(
        "Invalid step-up code",
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
      );
    }
    // A code proves presence once: the same code cannot mint a second token.
    const replayKey = `step-up:${createHash("sha256")
      .update(`${subject}:${trimmed}`)
      .digest("hex")}`;
    let fresh: boolean;
    try {
      fresh = await this.store.reserve(
        replayKey,
        STEP_UP_REPLAY_WINDOW_SECONDS,
      );
    } catch {
      this.rejected(CapabilityRejection.STORE_UNAVAILABLE, { sub: subject });
    }
    if (!fresh) {
      throw new AppException(
        "This step-up code has already been used",
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        { recoveryGuidance: "Wait for the next authenticator code and retry." },
      );
    }
  }

  private resolveTtl(requested: number | null | undefined): number {
    if (requested === null || requested === undefined) return this.defaultTtl;
    if (
      !Number.isInteger(requested) ||
      requested < MIN_CAPABILITY_TTL_SECONDS ||
      requested > this.maxTtl
    ) {
      throw new AppException(
        `ttlSeconds must be an integer between ${MIN_CAPABILITY_TTL_SECONDS} and ${this.maxTtl}`,
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_PARAMETER,
      );
    }
    return requested;
  }

  private isExpired(claims: CapabilityClaims): boolean {
    return Math.floor(this.now() / 1000) >= claims.exp;
  }

  private remainingTtl(claims: CapabilityClaims): number {
    return Math.max(1, claims.exp - Math.floor(this.now() / 1000));
  }

  private rejected(
    reason: CapabilityRejection,
    context: {
      jti?: string;
      sub?: string;
      subject?: string;
      act?: string;
      action?: string;
    },
  ): never {
    this.logger.warn({
      event: "capability.rejected",
      reason,
      jti: context.jti,
      sub: context.sub ?? context.subject,
      act: context.act ?? context.action,
    });
    throw new CapabilityTokenException(reason);
  }
}

function normaliseResource(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
