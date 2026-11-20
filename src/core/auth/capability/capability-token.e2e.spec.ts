import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { GlobalExceptionFilter } from "src/common/filters/global-exception.filter";
import { ApiKeysController } from "../api-keys.controller";
import { ApiKeysService } from "../api-keys.service";
import { TokenBlacklistService } from "../token-blacklist.service";
import { CAPABILITY_STEP_UP_VERIFIER } from "./capability-step-up.verifier";
import { CapabilityTokenController } from "./capability-token.controller";
import { CapabilityTokenInterceptor } from "./capability-token.interceptor";
import {
  CAPABILITY_TOKEN_OPTIONS,
  CapabilityTokenService,
} from "./capability-token.service";
import {
  CAPABILITY_TOKEN_STORE,
  InMemoryCapabilityTokenStore,
} from "./capability-token.store";
import { CapabilityAction } from "./capability-token.types";

/**
 * HTTP-level proof (#273) that the API key routes honour capability tokens:
 * normal, failure, retry and authorization paths, with the enforcement flag
 * both off (existing contract) and on.
 */

const KEY_ID = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const FLAKY_KEY_ID = "1b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";

/** Stands in for the global StrategyAuthGuard: identity from test headers. */
@Injectable()
class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const id = req.headers["x-test-user"];
    if (!id) return false;
    req.authType = req.headers["x-test-auth"] ?? "traditional";
    req.user = { id, type: req.authType, role: "user" };
    return true;
  }
}

describe("capability tokens on sensitive API key routes (#273)", () => {
  let app: INestApplication;
  let store: InMemoryCapabilityTokenStore;
  const keys = {
    create: jest.fn(async (userId: string, name: string) => ({
      id: KEY_ID,
      name,
      key: "sk_plaintext",
      userId,
    })),
    list: jest.fn(async () => []),
    revoke: jest.fn(async (_userId: string, id: string) => ({
      id,
      revoked: true,
    })),
  };
  let flakyFailuresLeft = 0;
  const originalFlag = process.env.CAPABILITY_TOKENS_ENFORCED;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    store = new InMemoryCapabilityTokenStore();
    keys.revoke.mockImplementation(async (_userId: string, id: string) => {
      if (id === FLAKY_KEY_ID && flakyFailuresLeft-- > 0) {
        throw new ServiceUnavailableException("database briefly unavailable");
      }
      return { id, revoked: true };
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [ApiKeysController, CapabilityTokenController],
      providers: [
        { provide: APP_GUARD, useClass: HeaderAuthGuard },
        { provide: ApiKeysService, useValue: keys },
        { provide: CAPABILITY_TOKEN_STORE, useValue: store },
        {
          provide: CAPABILITY_STEP_UP_VERIFIER,
          useValue: {
            isRequired: async () => false,
            verify: async () => false,
          },
        },
        {
          provide: CAPABILITY_TOKEN_OPTIONS,
          useValue: { secrets: ["e2e-capability-secret-0123456789abcdef"] },
        },
        TokenBlacklistService,
        CapabilityTokenService,
        CapabilityTokenInterceptor,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(
      new GlobalExceptionFilter({
        get: (key: string) => (key === "NODE_ENV" ? "production" : undefined),
      } as unknown as ConfigService),
    );
    await app.init();
  });

  afterAll(async () => {
    if (originalFlag === undefined)
      delete process.env.CAPABILITY_TOKENS_ENFORCED;
    else process.env.CAPABILITY_TOKENS_ENFORCED = originalFlag;
    store.onModuleDestroy();
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    keys.create.mockClear();
    keys.revoke.mockClear();
    delete process.env.CAPABILITY_TOKENS_ENFORCED;
  });

  const server = () => app.getHttpServer();

  async function mint(
    action: CapabilityAction,
    resourceId?: string,
    user = "user-1",
  ): Promise<string> {
    const res = await request(server())
      .post("/auth/capabilities")
      .set("x-test-user", user)
      .send({ action, resourceId })
      .expect(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    return res.body.token;
  }

  describe("enforcement off (default, existing contract)", () => {
    it("create and revoke still work without a token", async () => {
      await request(server())
        .post("/auth/api-keys")
        .set("x-test-user", "user-1")
        .send({ name: "ci" })
        .expect(201);
      await request(server())
        .delete(`/auth/api-keys/${KEY_ID}`)
        .set("x-test-user", "user-1")
        .expect(200);
      expect(keys.create).toHaveBeenCalledTimes(1);
      expect(keys.revoke).toHaveBeenCalledTimes(1);
    });

    it("a token that is sent is still verified (opt-in clients get real protection)", async () => {
      const token = await mint(CapabilityAction.API_KEY_REVOKE, "another-key");
      const res = await request(server())
        .delete(`/auth/api-keys/${KEY_ID}`)
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .expect(403);
      expect(res.body.errorCode).toBe("FORBIDDEN");
      expect(keys.revoke).not.toHaveBeenCalled();
    });
  });

  describe("enforcement on", () => {
    beforeEach(() => {
      process.env.CAPABILITY_TOKENS_ENFORCED = "true";
    });

    it("rejects a missing token with 428 and recovery guidance", async () => {
      const res = await request(server())
        .post("/auth/api-keys")
        .set("x-test-user", "user-1")
        .send({ name: "ci" })
        .expect(428);
      expect(res.body.errorCode).toBe("PRECONDITION_FAILED");
      expect(res.body.recoveryGuidance).toMatch(/POST \/auth\/capabilities/);
      expect(keys.create).not.toHaveBeenCalled();
    });

    it("normal path: a minted token authorizes exactly one create", async () => {
      const token = await mint(CapabilityAction.API_KEY_CREATE);
      await request(server())
        .post("/auth/api-keys")
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .send({ name: "ci" })
        .expect(201);

      const replay = await request(server())
        .post("/auth/api-keys")
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .send({ name: "ci-2" })
        .expect(409);
      expect(replay.body.errorCode).toBe("CONFLICT");
      expect(replay.body.retryable).toBe(false);
      expect(keys.create).toHaveBeenCalledTimes(1);
    });

    it("retry path: a failed revoke releases the token for a retry", async () => {
      flakyFailuresLeft = 1;
      const token = await mint(CapabilityAction.API_KEY_REVOKE, FLAKY_KEY_ID);
      const call = () =>
        request(server())
          .delete(`/auth/api-keys/${FLAKY_KEY_ID}`)
          .set("x-test-user", "user-1")
          .set("x-capability-token", token);

      await call().expect(503);
      await call().expect(200);
      await call().expect(409);
      expect(keys.revoke).toHaveBeenCalledTimes(2);
    });

    it("validation failures in the handler pipeline also release the token", async () => {
      const token = await mint(CapabilityAction.API_KEY_REVOKE, "not-a-uuid");
      await request(server())
        .delete("/auth/api-keys/not-a-uuid")
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .expect(400);
      expect(await store.state((await decodeJti(token)) as string)).toBeNull();
    });

    it.each([
      ["another user's token", "user-2", undefined, KEY_ID],
      [
        "a token for a different key",
        "user-1",
        undefined,
        "9b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9",
      ],
      ["a token presented with API key auth", "user-1", "api-key", KEY_ID],
    ])("authorization: refuses %s", async (_label, caller, authType, path) => {
      const token = await mint(CapabilityAction.API_KEY_REVOKE, KEY_ID);
      const req = request(server())
        .delete(`/auth/api-keys/${path}`)
        .set("x-test-user", caller)
        .set("x-capability-token", token);
      if (authType) req.set("x-test-auth", authType);
      await req.expect(403);
      expect(keys.revoke).not.toHaveBeenCalled();
    });

    it("a create token cannot be spent on a revoke", async () => {
      const token = await mint(CapabilityAction.API_KEY_CREATE);
      await request(server())
        .delete(`/auth/api-keys/${KEY_ID}`)
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .expect(403);
    });

    it("a revoked token is refused", async () => {
      const token = await mint(CapabilityAction.API_KEY_REVOKE, KEY_ID);
      await request(server())
        .post("/auth/capabilities/revoke")
        .set("x-test-user", "user-1")
        .send({ token })
        .expect(200)
        .expect((res) => expect(res.body.revoked).toBe(true));
      await request(server())
        .delete(`/auth/api-keys/${KEY_ID}`)
        .set("x-test-user", "user-1")
        .set("x-capability-token", token)
        .expect(409);
    });
  });

  it("API keys cannot mint capability tokens", async () => {
    await request(server())
      .post("/auth/capabilities")
      .set("x-test-user", "user-1")
      .set("x-test-auth", "api-key")
      .send({ action: CapabilityAction.API_KEY_CREATE })
      .expect(403);
  });

  it("lists the actions that accept capability tokens", async () => {
    const res = await request(server())
      .get("/auth/capabilities/actions")
      .set("x-test-user", "user-1")
      .expect(200);
    expect(res.body.map((entry: any) => entry.action).sort()).toEqual(
      Object.values(CapabilityAction).sort(),
    );
  });
});

async function decodeJti(token: string): Promise<string> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    .jti;
}
