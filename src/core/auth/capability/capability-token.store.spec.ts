import {
  CapabilityRedisClient,
  InMemoryCapabilityTokenStore,
  RedisCapabilityTokenStore,
} from "./capability-token.store";
import { createCapabilityTokenStore } from "./capability-token.providers";

/** Minimal in-memory Redis double honouring SET NX/EX and the release script. */
class FakeRedis implements CapabilityRedisClient {
  readonly data = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  evalCalls = 0;

  async set(key: string, value: string, _mode: "EX", ttl: number, nx?: "NX") {
    if (nx === "NX" && this.data.has(key)) return null;
    this.data.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
  async eval(_script: string, _n: number, key: string, expected: string) {
    this.evalCalls += 1;
    if (this.data.get(key) !== expected) return 0;
    this.data.delete(key);
    return 1;
  }
}

describe("capability token stores (#273)", () => {
  describe("in-memory", () => {
    let now = 1_000_000;
    const store = new InMemoryCapabilityTokenStore(() => now);
    afterAll(() => store.onModuleDestroy());

    it("reserves once, releases for retry, and consumes terminally", async () => {
      expect(await store.reserve("a", 60)).toBe(true);
      expect(await store.reserve("a", 60)).toBe(false);
      expect(await store.state("a")).toBe("reserved");

      await store.release("a");
      expect(await store.state("a")).toBeNull();
      expect(await store.reserve("a", 60)).toBe(true);

      await store.consume("a", 60);
      await store.release("a"); // a late release must not resurrect it
      expect(await store.state("a")).toBe("consumed");
      expect(await store.reserve("a", 60)).toBe(false);
    });

    it("keeps revocation independent of the use state", async () => {
      await store.revoke("b", 60);
      expect(await store.isRevoked("b")).toBe(true);
      expect(await store.reserve("b", 60)).toBe(true);
      await store.release("b");
      expect(await store.isRevoked("b")).toBe(true);
    });

    it("forgets state once its TTL passes", async () => {
      expect(await store.reserve("c", 5)).toBe(true);
      now += 5_000;
      expect(await store.state("c")).toBeNull();
      expect(await store.isRevoked("b")).toBe(true); // 60s TTL still live
      now += 60_000;
      expect(store.size()).toBe(0);
    });
  });

  describe("redis", () => {
    it("uses SET NX for reservation and the guarded release script", async () => {
      const redis = new FakeRedis();
      const store = new RedisCapabilityTokenStore(redis);

      expect(await store.reserve("a", 120.4)).toBe(true);
      expect(redis.ttls.get("capability:use:a")).toBe(121);
      expect(await store.reserve("a", 120)).toBe(false);

      await store.release("a");
      expect(redis.evalCalls).toBe(1);
      expect(await store.state("a")).toBeNull();

      await store.reserve("a", 120);
      await store.consume("a", 120);
      await store.release("a");
      expect(await store.state("a")).toBe("consumed");

      await store.revoke("a", 30);
      expect(await store.isRevoked("a")).toBe(true);
      expect(await store.isRevoked("z")).toBe(false);
    });

    it("falls back to GET/DEL release when EVAL is unavailable", async () => {
      const redis = new FakeRedis();
      (redis as any).eval = undefined;
      const store = new RedisCapabilityTokenStore(redis);
      await store.reserve("a", 10);
      await store.release("a");
      expect(await store.state("a")).toBeNull();
    });

    it("propagates backend errors so callers can fail closed", async () => {
      const redis = new FakeRedis();
      redis.set = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const store = new RedisCapabilityTokenStore(redis);
      await expect(store.reserve("a", 10)).rejects.toThrow("ECONNREFUSED");
    });
  });

  it("selects Redis when the shared client exists, memory otherwise", () => {
    expect(createCapabilityTokenStore(new FakeRedis())).toBeInstanceOf(
      RedisCapabilityTokenStore,
    );
    const memory = createCapabilityTokenStore(null);
    expect(memory).toBeInstanceOf(InMemoryCapabilityTokenStore);
    (memory as InMemoryCapabilityTokenStore).onModuleDestroy();
  });
});
