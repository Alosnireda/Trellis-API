import { HttpStatus, Logger } from "@nestjs/common";
import { ErrorCode } from "src/common/errors/error-codes";
import { TokenBlacklistService } from "../token-blacklist.service";
import { CapabilityStepUpVerifier } from "./capability-step-up.verifier";
import {
  buildKeyRing,
  decodeCapabilityToken,
  encodeCapabilityToken,
} from "./capability-token.codec";
import {
  capabilitySecretsFromEnv,
  CapabilityTokenException,
  CapabilityTokenService,
} from "./capability-token.service";
import {
  CapabilityTokenStore,
  InMemoryCapabilityTokenStore,
} from "./capability-token.store";
import {
  CapabilityAction,
  CapabilityRejection,
  CapabilityRequirement,
} from "./capability-token.types";

const SECRET = "test-capability-secret-0123456789abcdef";
const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);

class FakeStepUp implements CapabilityStepUpVerifier {
  required = false;
  validCode = "123456";
  async isRequired() {
    return this.required;
  }
  async verify(_userId: string, code: string) {
    return code === this.validCode;
  }
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("CapabilityTokenService (#273)", () => {
  let now: number;
  let store: InMemoryCapabilityTokenStore;
  let stepUp: FakeStepUp;
  let sessions: TokenBlacklistService;
  let service: CapabilityTokenService;

  const user = { id: "user-1", authType: "traditional" };
  const revokeKey1: CapabilityRequirement = {
    subject: "user-1",
    authType: "traditional",
    action: CapabilityAction.API_KEY_REVOKE,
    resourceId: "key-1",
  };

  function build(
    overrides: { store?: CapabilityTokenStore; secrets?: string[] } = {},
  ) {
    return new CapabilityTokenService(
      overrides.store ?? store,
      stepUp,
      sessions,
      { secrets: overrides.secrets ?? [SECRET], now: () => now },
    );
  }

  const mintRevoke = (resourceId = "key-1") =>
    service.mint({
      principal: user,
      action: CapabilityAction.API_KEY_REVOKE,
      resourceId,
    });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    now = T0;
    store = new InMemoryCapabilityTokenStore(() => now);
    stepUp = new FakeStepUp();
    sessions = new TokenBlacklistService();
    service = build();
  });

  afterEach(async () => {
    store.onModuleDestroy();
    await sessions.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe("mint", () => {
    it("issues a bound, signed token with the default 5 minute lifetime", async () => {
      const minted = await mintRevoke();
      expect(minted).toMatchObject({
        action: CapabilityAction.API_KEY_REVOKE,
        resourceId: "key-1",
        ttlSeconds: 300,
        issuedAt: new Date(T0).toISOString(),
        expiresAt: new Date(T0 + 300_000).toISOString(),
      });
      const decoded = decodeCapabilityToken(
        minted.token,
        buildKeyRing([SECRET]),
      );
      expect(decoded.ok && decoded.claims).toMatchObject({
        sub: "user-1",
        act: CapabilityAction.API_KEY_REVOKE,
        res: "key-1",
        jti: minted.tokenId,
      });
    });

    it("never logs the token itself", async () => {
      const minted = await mintRevoke();
      const logged = JSON.stringify(
        (Logger.prototype.log as jest.Mock).mock.calls,
      );
      expect(logged).toContain(minted.tokenId);
      expect(logged).not.toContain(minted.token);
    });

    it.each([
      [
        "api-key principal",
        { principal: { id: "user-1", authType: "api-key" } },
        HttpStatus.FORBIDDEN,
      ],
      ["anonymous principal", { principal: {} }, HttpStatus.UNAUTHORIZED],
      [
        "unknown action",
        { action: "treasury.payout.initiated" },
        HttpStatus.BAD_REQUEST,
      ],
      [
        "resource-bound action without resource",
        { resourceId: undefined },
        HttpStatus.BAD_REQUEST,
      ],
      [
        "unbound action with resource",
        { action: CapabilityAction.API_KEY_CREATE },
        HttpStatus.BAD_REQUEST,
      ],
      ["ttl above the ceiling", { ttlSeconds: 3600 }, HttpStatus.BAD_REQUEST],
      ["ttl below the floor", { ttlSeconds: 5 }, HttpStatus.BAD_REQUEST],
    ])("refuses to mint for %s", async (_label, patch, status) => {
      const error: any = await rejection(
        service.mint({
          principal: user,
          action: CapabilityAction.API_KEY_REVOKE,
          resourceId: "key-1",
          ...(patch as any),
        }),
      );
      expect(error.getStatus()).toBe(status);
    });

    it("fails closed with 503 when no signing secret is configured", async () => {
      service = build({ secrets: [] });
      const error: any = await rejection(mintRevoke());
      expect(error.reason).toBe(CapabilityRejection.SIGNING_UNAVAILABLE);
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    describe("step-up for accounts with 2FA", () => {
      beforeEach(() => {
        stepUp.required = true;
      });

      it("requires a code (428) and rejects a wrong one (401)", async () => {
        const missing: any = await rejection(mintRevoke());
        expect(missing.getStatus()).toBe(HttpStatus.PRECONDITION_REQUIRED);

        const wrong: any = await rejection(
          service.mint({
            principal: user,
            action: CapabilityAction.API_KEY_REVOKE,
            resourceId: "key-1",
            stepUpCode: "000000",
          }),
        );
        expect(wrong.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(wrong.errorCode).toBe(ErrorCode.INVALID_CREDENTIALS);
      });

      it("accepts a valid code once and refuses to replay it", async () => {
        const input = {
          principal: user,
          action: CapabilityAction.API_KEY_REVOKE,
          resourceId: "key-1",
          stepUpCode: "123456",
        };
        await expect(service.mint(input)).resolves.toHaveProperty("token");
        const replay: any = await rejection(service.mint(input));
        expect(replay.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect(replay.message).toMatch(/already been used/);
      });

      it("a wrong code does not burn the valid one", async () => {
        await rejection(
          service.mint({
            principal: user,
            action: CapabilityAction.API_KEY_REVOKE,
            resourceId: "key-1",
            stepUpCode: "000000",
          }),
        );
        await expect(
          service.mint({
            principal: user,
            action: CapabilityAction.API_KEY_REVOKE,
            resourceId: "key-1",
            stepUpCode: "123456",
          }),
        ).resolves.toHaveProperty("token");
      });
    });
  });

  describe("claim / commit / release", () => {
    it("normal path: claims, commits, and refuses any replay", async () => {
      const { token } = await mintRevoke();
      const claim = await service.claim(token, revokeKey1);
      await service.commit(claim);

      const replay: any = await rejection(service.claim(token, revokeKey1));
      expect(replay.reason).toBe(CapabilityRejection.CONSUMED);
      expect(replay.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(replay.retryable).toBe(false);
    });

    it("retry path: a released token can be claimed again", async () => {
      const { token } = await mintRevoke();
      const first = await service.claim(token, revokeKey1);
      await service.release(first);
      const second = await service.claim(token, revokeKey1);
      expect(second.claims.jti).toBe(first.claims.jti);
    });

    it("concurrent claims: exactly one wins, the other is told to retry", async () => {
      const { token } = await mintRevoke();
      const results = await Promise.allSettled([
        service.claim(token, revokeKey1),
        service.claim(token, revokeKey1),
        service.claim(token, revokeKey1),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const loser of lost) {
        expect(loser.reason.reason).toBe(CapabilityRejection.IN_USE);
        expect(loser.reason.retryable).toBe(true);
        expect(loser.reason.retryAfterSeconds).toBe(1);
      }
    });

    it.each([
      [
        "missing",
        null,
        {},
        CapabilityRejection.MISSING,
        HttpStatus.PRECONDITION_REQUIRED,
      ],
      [
        "another subject",
        undefined,
        { subject: "user-2" },
        CapabilityRejection.SUBJECT_MISMATCH,
        HttpStatus.FORBIDDEN,
      ],
      [
        "another action",
        undefined,
        { action: CapabilityAction.API_KEY_CREATE, resourceId: null },
        CapabilityRejection.ACTION_MISMATCH,
        HttpStatus.FORBIDDEN,
      ],
      [
        "another resource",
        undefined,
        { resourceId: "key-2" },
        CapabilityRejection.RESOURCE_MISMATCH,
        HttpStatus.FORBIDDEN,
      ],
      [
        "an api-key principal",
        undefined,
        { authType: "api-key" },
        CapabilityRejection.API_KEY_PRINCIPAL,
        HttpStatus.FORBIDDEN,
      ],
      [
        "a garbage token",
        "cap1.xxx.yyy",
        {},
        CapabilityRejection.MALFORMED,
        HttpStatus.FORBIDDEN,
      ],
    ])(
      "authorization: rejects %s",
      async (_label, tokenOverride, patch, reason, status) => {
        const { token } = await mintRevoke();
        const error: any = await rejection(
          service.claim(tokenOverride === undefined ? token : tokenOverride, {
            ...revokeKey1,
            ...(patch as any),
          }),
        );
        expect(error).toBeInstanceOf(CapabilityTokenException);
        expect(error.reason).toBe(reason);
        expect(error.getStatus()).toBe(status);
      },
    );

    it("a rejected claim does not consume the token", async () => {
      const { token } = await mintRevoke();
      await rejection(
        service.claim(token, { ...revokeKey1, resourceId: "key-2" }),
      );
      await expect(service.claim(token, revokeKey1)).resolves.toBeDefined();
    });

    it("expires exactly at exp, even if the token was never used", async () => {
      const { token } = await service.mint({
        principal: user,
        action: CapabilityAction.API_KEY_REVOKE,
        resourceId: "key-1",
        ttlSeconds: 60,
      });
      now = T0 + 59_000;
      const claim = await service.claim(token, revokeKey1);
      await service.release(claim);

      now = T0 + 60_000;
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.EXPIRED);
      expect(error.errorCode).toBe(ErrorCode.TOKEN_EXPIRED);
    });

    it("rejects tokens issued too far in the future (clock skew guard)", async () => {
      now = T0 + 120_000;
      const { token } = await mintRevoke();
      now = T0;
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.NOT_YET_VALID);
    });

    it("dies with the session: 'log out everywhere' kills outstanding tokens", async () => {
      const { token } = await mintRevoke();
      now += 1_000;
      await sessions.revokeSubjectSessions("user-1", Math.floor(now / 1000));
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.SESSION_REVOKED);
      expect(error.errorCode).toBe(ErrorCode.SESSION_TERMINATED);
    });

    it("fails closed with 503 when the store is unreachable", async () => {
      const broken: CapabilityTokenStore = {
        reserve: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        consume: jest.fn(),
        release: jest.fn(),
        state: jest.fn(),
        revoke: jest.fn(),
        isRevoked: jest.fn().mockResolvedValue(false),
      };
      const { token } = await mintRevoke();
      service = build({ store: broken });
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.STORE_UNAVAILABLE);
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.retryable).toBe(true);
    });

    it("commit and release never throw; a failed release leaves the token unusable", async () => {
      const { token } = await mintRevoke();
      const claim = await service.claim(token, revokeKey1);
      jest.spyOn(store, "release").mockRejectedValueOnce(new Error("down"));
      await expect(service.release(claim)).resolves.toBeUndefined();
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.IN_USE);

      jest.spyOn(store, "consume").mockRejectedValueOnce(new Error("down"));
      await expect(service.commit(claim)).resolves.toBeUndefined();
    });

    it("accepts tokens minted before a key rotation and rejects them after rollback of the old key", async () => {
      const oldSecret = "old-capability-secret-0123456789abcdef";
      service = build({ secrets: [oldSecret] });
      const { token } = await mintRevoke();

      service = build({ secrets: [SECRET, oldSecret] });
      const claim = await service.claim(token, revokeKey1);
      await service.release(claim);

      service = build({ secrets: [SECRET] });
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.UNKNOWN_KEY);
    });
  });

  describe("execute", () => {
    it("consumes on success and releases on failure (rethrowing the original error)", async () => {
      const { token } = await mintRevoke();
      const boom = new Error("database unavailable");
      await expect(
        service.execute(token, revokeKey1, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      await expect(
        service.execute(token, revokeKey1, async () => "done"),
      ).resolves.toBe("done");

      const error: any = await rejection(
        service.execute(token, revokeKey1, async () => "again"),
      );
      expect(error.reason).toBe(CapabilityRejection.CONSUMED);
    });
  });

  describe("revoke", () => {
    it("revokes an unused token so it can never be claimed", async () => {
      const { token, tokenId } = await mintRevoke();
      await expect(service.revoke(token, user)).resolves.toEqual({
        tokenId,
        revoked: true,
        expired: false,
      });
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.REVOKED);
    });

    it("revocation survives a concurrent release of an in-flight claim", async () => {
      const { token } = await mintRevoke();
      const claim = await service.claim(token, revokeKey1);
      await service.revoke(token, user);
      await service.release(claim);
      const error: any = await rejection(service.claim(token, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.REVOKED);
    });

    it("only the owner may revoke; expired tokens are a no-op", async () => {
      const { token } = await mintRevoke();
      const error: any = await rejection(
        service.revoke(token, { id: "user-2", authType: "traditional" }),
      );
      expect(error.reason).toBe(CapabilityRejection.SUBJECT_MISMATCH);

      now = T0 + 301_000;
      await expect(service.revoke(token, user)).resolves.toMatchObject({
        revoked: true,
        expired: true,
      });
    });
  });

  describe("configuration", () => {
    it("prefers explicit secrets, newest first", () => {
      expect(
        capabilitySecretsFromEnv({
          CAPABILITY_TOKEN_SECRET: " new ",
          CAPABILITY_TOKEN_PREVIOUS_SECRET: "old",
          JWT_SECRET: "jwt",
        }),
      ).toEqual(["new", "old"]);
    });

    it("derives a separate key from JWT_SECRET when none is set", () => {
      const [derived] = capabilitySecretsFromEnv({ JWT_SECRET: "jwt-secret" });
      expect(derived).toMatch(/^[0-9a-f]{64}$/);
      expect(derived).not.toContain("jwt-secret");
      expect(capabilitySecretsFromEnv({})).toEqual([]);
    });

    it("a token signed with the raw JWT secret does not verify against the derived key", async () => {
      service = build({
        secrets: capabilitySecretsFromEnv({ JWT_SECRET: SECRET }),
      });
      const forged = encodeCapabilityToken(
        {
          v: 1,
          kid: "",
          jti: "j-1",
          sub: "user-1",
          act: CapabilityAction.API_KEY_REVOKE,
          res: "key-1",
          iat: Math.floor(T0 / 1000),
          exp: Math.floor(T0 / 1000) + 60,
        },
        buildKeyRing([SECRET]).active,
      );
      const error: any = await rejection(service.claim(forged, revokeKey1));
      expect(error.reason).toBe(CapabilityRejection.UNKNOWN_KEY);
    });
  });
});
