import { OnModuleDestroy } from "@nestjs/common";

/**
 * Single-use state for capability tokens (#273).
 *
 * Two independent keys per token id:
 *   - `use:<jti>`     reserved by exactly one in-flight execution (SET NX),
 *                     deleted again if that execution fails (so the caller can
 *                     retry), or marked consumed when it succeeds;
 *   - `revoked:<jti>` set by an explicit revocation.
 *
 * Revocation lives in its own key so a concurrent release of a reservation
 * can never erase it. Every entry carries a TTL equal to the token's remaining
 * lifetime: once the token has expired its signature check rejects it anyway,
 * so the state is no longer needed.
 *
 * Unlike the jti blacklist, this store does **not** fall back to process
 * memory when a shared backend fails: a local fallback would let a token be
 * used once per replica. Callers treat a store error as "deny".
 */
export interface CapabilityTokenStore {
  /** Atomically reserve `id`; false when it is already reserved or consumed. */
  reserve(id: string, ttlSeconds: number): Promise<boolean>;
  /** Mark a reserved id as consumed (terminal). */
  consume(id: string, ttlSeconds: number): Promise<void>;
  /** Drop a reservation so the token can be retried. */
  release(id: string): Promise<void>;
  /** Current use state of the id. */
  state(id: string): Promise<"reserved" | "consumed" | null>;
  revoke(id: string, ttlSeconds: number): Promise<void>;
  isRevoked(id: string): Promise<boolean>;
}

/** Provider token for the store implementation. */
export const CAPABILITY_TOKEN_STORE = "CAPABILITY_TOKEN_STORE";

const RESERVED = "reserved";
const CONSUMED = "consumed";

/**
 * In-process store. Correct for a single replica; the default so the feature
 * works without Redis. Multi-replica deployments must bind
 * {@link RedisCapabilityTokenStore} to {@link CAPABILITY_TOKEN_STORE}
 * (done automatically when the global cache Redis client is configured).
 */
export class InMemoryCapabilityTokenStore
  implements CapabilityTokenStore, OnModuleDestroy
{
  private readonly entries = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async reserve(id: string, ttlSeconds: number): Promise<boolean> {
    if (this.read(`use:${id}`) !== null) return false;
    this.write(`use:${id}`, RESERVED, ttlSeconds);
    return true;
  }

  async consume(id: string, ttlSeconds: number): Promise<void> {
    this.write(`use:${id}`, CONSUMED, ttlSeconds);
  }

  async release(id: string): Promise<void> {
    if (this.read(`use:${id}`) === RESERVED) this.entries.delete(`use:${id}`);
  }

  async state(id: string): Promise<"reserved" | "consumed" | null> {
    return this.read(`use:${id}`) as "reserved" | "consumed" | null;
  }

  async revoke(id: string, ttlSeconds: number): Promise<void> {
    this.write(`revoked:${id}`, "1", ttlSeconds);
  }

  async isRevoked(id: string): Promise<boolean> {
    return this.read(`revoked:${id}`) !== null;
  }

  /** Number of live entries (tests and diagnostics). */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlSeconds: number): void {
    this.entries.set(key, {
      value,
      expiresAt: this.now() + Math.max(1, Math.ceil(ttlSeconds)) * 1000,
    });
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

/** The subset of the ioredis client the Redis store needs. */
export interface CapabilityRedisClient {
  set(
    key: string,
    value: string,
    mode: "EX",
    ttlSeconds: number,
    condition?: "NX",
  ): Promise<"OK" | null | unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval?(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/** Deletes the key only while it still holds the reservation marker. */
const RELEASE_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/** Shared store for multi-replica deployments. */
export class RedisCapabilityTokenStore implements CapabilityTokenStore {
  constructor(
    private readonly client: CapabilityRedisClient,
    private readonly prefix = "capability:",
  ) {}

  async reserve(id: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(
      this.useKey(id),
      RESERVED,
      "EX",
      ttl(ttlSeconds),
      "NX",
    );
    return result === "OK";
  }

  async consume(id: string, ttlSeconds: number): Promise<void> {
    await this.client.set(this.useKey(id), CONSUMED, "EX", ttl(ttlSeconds));
  }

  async release(id: string): Promise<void> {
    const key = this.useKey(id);
    if (this.client.eval) {
      await this.client.eval(RELEASE_SCRIPT, 1, key, RESERVED);
      return;
    }
    // Without EVAL the check-then-delete is not atomic. The only writer that
    // can race it is `consume` from the same execution, which never runs
    // concurrently with its own release, so this is safe in practice.
    if ((await this.client.get(key)) === RESERVED) await this.client.del(key);
  }

  async state(id: string): Promise<"reserved" | "consumed" | null> {
    const value = await this.client.get(this.useKey(id));
    return value === RESERVED || value === CONSUMED ? value : null;
  }

  async revoke(id: string, ttlSeconds: number): Promise<void> {
    await this.client.set(this.revokedKey(id), "1", "EX", ttl(ttlSeconds));
  }

  async isRevoked(id: string): Promise<boolean> {
    return (await this.client.get(this.revokedKey(id))) !== null;
  }

  private useKey(id: string): string {
    return `${this.prefix}use:${id}`;
  }

  private revokedKey(id: string): string {
    return `${this.prefix}revoked:${id}`;
  }
}

function ttl(seconds: number): number {
  return Math.max(1, Math.ceil(seconds));
}
