import { ForbiddenException } from "@nestjs/common";
import { StorageTtlService } from "./storage-ttl.service";
import {
  DEFAULT_TTL_POLICY as P,
  EntryTtl,
  LedgerTtlGateway,
  TrackedEntry,
  TtlGatewayError,
} from "./storage-ttl.types";

const NOW = 1_000_000;
const ADMIN = { id: "admin-1", roles: ["ADMIN"] };
const entries: TrackedEntry[] = [
  { key: "expiring", durability: "persistent" },
  { key: "archived", durability: "persistent" },
  { key: "healthy", durability: "persistent" },
  { key: "gone", durability: "temporary" },
];

function makeGateway(ttls: Record<string, EntryTtl | null>) {
  const state = { ...ttls };
  const gateway: jest.Mocked<LedgerTtlGateway> = {
    getCurrentLedger: jest.fn(async () => NOW),
    getTtls: jest.fn(async (keys: string[]) =>
      Object.fromEntries(keys.map((k) => [k, state[k] ?? null])),
    ),
    extendTtl: jest.fn(async (key: string, to: number) => {
      state[key] = { liveUntilLedger: NOW + to };
    }),
    restore: jest.fn(async (key: string) => {
      state[key] = { liveUntilLedger: NOW + 10 };
    }),
  };
  return { gateway, state };
}

const baseTtls = (): Record<string, EntryTtl | null> => ({
  expiring: { liveUntilLedger: NOW + 50_000 },
  archived: { liveUntilLedger: null, archived: true },
  healthy: { liveUntilLedger: NOW + P.extendToLedgers },
  gone: { liveUntilLedger: null, archived: true },
});

const service = (
  g: LedgerTtlGateway,
  opts: ConstructorParameters<typeof StorageTtlService>[1] = {},
) =>
  new StorageTtlService(g, {
    sleep: async () => undefined,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...opts,
  });

describe("StorageTtlService.scan (#337)", () => {
  it("reports health per entry without mutating anything", async () => {
    const { gateway } = makeGateway(baseTtls());
    const report = await service(gateway).scan(entries);
    expect(report.counts).toMatchObject({
      healthy: 1,
      expiring: 1,
      archived: 1,
      expired: 1,
    });
    expect(gateway.extendTtl).not.toHaveBeenCalled();
    expect(gateway.restore).not.toHaveBeenCalled();
  });

  it("skips the gateway lookup for an empty list and rejects duplicate keys", async () => {
    const { gateway } = makeGateway({});
    expect((await service(gateway).scan([])).assessments).toEqual([]);
    expect(gateway.getTtls).not.toHaveBeenCalled();
    await expect(
      service(gateway).scan([entries[0], entries[0]]),
    ).rejects.toThrow("Duplicate tracked key");
  });

  it("propagates gateway failures so monitoring can alert", async () => {
    const { gateway } = makeGateway({});
    gateway.getCurrentLedger.mockRejectedValue(new Error("rpc down"));
    await expect(service(gateway).scan(entries)).rejects.toThrow("rpc down");
  });

  it("rejects an invalid policy at construction", () => {
    const { gateway } = makeGateway({});
    expect(() =>
      service(gateway, {
        policy: { ...P, criticalBelowLedgers: P.warnBelowLedgers },
      }),
    ).toThrow();
  });
});

describe("StorageTtlService.repair authorization", () => {
  it.each([[["USER"]], [["MAINTAINER"]], [[]]])(
    "refuses non-admin roles %j before touching the chain",
    async (roles) => {
      const { gateway } = makeGateway(baseTtls());
      await expect(
        service(gateway).repair(entries, { id: "u", roles }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(gateway.getCurrentLedger).not.toHaveBeenCalled();
    },
  );
});

describe("StorageTtlService.repair", () => {
  it("dry-run plans repairs but changes nothing", async () => {
    const { gateway } = makeGateway(baseTtls());
    const run = await service(gateway).repair(entries, ADMIN, { dryRun: true });
    expect(run.dryRun).toBe(true);
    expect(run.results.map((r) => r.outcome)).toEqual(["dry-run", "dry-run"]);
    expect(gateway.extendTtl).not.toHaveBeenCalled();
    expect(gateway.restore).not.toHaveBeenCalled();
  });

  it("restores then extends archived entries, extends expiring ones, and reports unrecoverable", async () => {
    const { gateway } = makeGateway(baseTtls());
    const run = await service(gateway).repair(entries, ADMIN);
    expect(run.repaired).toBe(2);
    expect(run.failed).toBe(0);
    expect(gateway.restore).toHaveBeenCalledWith("archived");
    expect(gateway.extendTtl).toHaveBeenCalledWith(
      "archived",
      P.extendToLedgers,
    );
    expect(gateway.extendTtl).toHaveBeenCalledWith(
      "expiring",
      P.extendToLedgers,
    );
    expect(gateway.restore).not.toHaveBeenCalledWith("expiring");
    expect(run.plan.unrecoverable.map((u) => u.key)).toEqual(["gone"]);
  });

  it("is idempotent: a second run finds nothing left to repair", async () => {
    const { gateway } = makeGateway(baseTtls());
    const svc = service(gateway);
    await svc.repair(entries, ADMIN);
    gateway.extendTtl.mockClear();
    gateway.restore.mockClear();
    const second = await svc.repair(entries, ADMIN);
    expect(second.results).toEqual([]);
    expect(gateway.extendTtl).not.toHaveBeenCalled();
  });

  it("skips entries another run renewed between planning and acting", async () => {
    const { gateway, state } = makeGateway(baseTtls());
    const original = gateway.getTtls.getMockImplementation()!;
    let calls = 0;
    gateway.getTtls.mockImplementation(async (keys) => {
      calls++;
      if (calls > 1) {
        state.expiring = { liveUntilLedger: NOW + P.extendToLedgers };
        state.archived = { liveUntilLedger: NOW + P.extendToLedgers };
      }
      return original(keys);
    });
    const run = await service(gateway).repair(entries, ADMIN);
    expect(run.skipped).toBe(2);
    expect(run.results.map((r) => r.detail)).toEqual([
      "Already restored by another run",
      "Already renewed by another run",
    ]);
    expect(gateway.extendTtl).not.toHaveBeenCalled();
  });

  it("retries transient failures with exponential backoff and then succeeds", async () => {
    const { gateway } = makeGateway(baseTtls());
    gateway.extendTtl
      .mockRejectedValueOnce(new TtlGatewayError("timeout", true))
      .mockRejectedValueOnce(new TtlGatewayError("503", true));
    const sleep = jest.fn(async () => undefined);
    const run = await service(gateway, { sleep, backoffMs: 100 }).repair(
      [entries[0]],
      ADMIN,
    );
    expect(run.results[0]).toMatchObject({ outcome: "repaired", attempts: 3 });
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("gives up after maxAttempts on persistent transient errors and keeps repairing the rest", async () => {
    const { gateway } = makeGateway(baseTtls());
    gateway.extendTtl.mockImplementation(async (key: string) => {
      if (key === "archived") throw new TtlGatewayError("timeout", true);
    });
    const run = await service(gateway, { maxAttempts: 2 }).repair(
      entries,
      ADMIN,
    );
    const byKey = Object.fromEntries(run.results.map((r) => [r.key, r]));
    expect(byKey.archived).toMatchObject({
      outcome: "failed",
      attempts: 2,
      detail: "timeout",
    });
    expect(byKey.expiring.outcome).toBe("repaired");
    expect(run.failed).toBe(1);
  });

  it("finishes a half-done repair on retry: restored but not yet extended is extended, not skipped", async () => {
    const { gateway } = makeGateway(baseTtls());
    gateway.extendTtl.mockRejectedValueOnce(
      new TtlGatewayError("timeout", true),
    );
    const run = await service(gateway).repair([entries[1]], ADMIN);
    expect(run.results[0]).toMatchObject({ outcome: "repaired", attempts: 2 });
    expect(gateway.restore).toHaveBeenCalledTimes(1);
    expect(gateway.extendTtl).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent errors and records non-Error throws", async () => {
    const { gateway } = makeGateway(baseTtls());
    gateway.extendTtl.mockRejectedValueOnce(
      new TtlGatewayError("bad footprint", false),
    );
    const first = await service(gateway).repair([entries[0]], ADMIN);
    expect(first.results[0]).toMatchObject({
      outcome: "failed",
      attempts: 1,
      detail: "bad footprint",
    });

    gateway.extendTtl.mockRejectedValueOnce("boom");
    const second = await service(gateway).repair([entries[0]], ADMIN);
    expect(second.results[0]).toMatchObject({
      outcome: "failed",
      detail: "boom",
    });
  });

  it("caps repairs per run and reports the deferred remainder", async () => {
    const { gateway } = makeGateway(baseTtls());
    const run = await service(gateway, { maxRepairsPerRun: 1 }).repair(
      entries,
      ADMIN,
    );
    expect(run.results.map((r) => r.key)).toEqual(["archived"]);
    expect(run.plan.deferred.map((d) => d.key)).toEqual(["expiring"]);
  });

  it("surfaces a failed pre-repair scan", async () => {
    const { gateway } = makeGateway(baseTtls());
    gateway.getTtls.mockRejectedValue(new Error("rpc down"));
    await expect(service(gateway).repair(entries, ADMIN)).rejects.toThrow(
      "rpc down",
    );
  });
});
