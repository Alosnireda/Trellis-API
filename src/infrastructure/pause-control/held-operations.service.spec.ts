import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import {
  HeldOperationsService,
  HoldRequest,
  PauseChecker,
} from "./held-operations.service";
import {
  HeldOperation,
  InMemoryHeldOperationStore,
} from "./held-operations.types";

const ADMIN = { id: "admin", roles: ["ADMIN"] };
const silent = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function setup(
  opts: {
    paused?: boolean;
    handlerImpl?: (op: HeldOperation) => Promise<void>;
  } = {},
) {
  let paused = opts.paused ?? true;
  let clock = new Date("2026-11-20T00:00:00Z");
  const pausedCalls: Array<() => void> = [];
  const pause: PauseChecker = {
    isOperationPaused: jest.fn(async () => {
      pausedCalls.forEach((f) => f());
      return { paused };
    }),
  };
  const handler = jest.fn(opts.handlerImpl ?? (async () => undefined));
  const store = new InMemoryHeldOperationStore();
  const svc = new HeldOperationsService(
    store,
    pause,
    { "payments.settle": handler },
    { now: () => clock, logger: silent, maxAttempts: 2, maxHeldPerScope: 3 },
  );
  return {
    svc,
    store,
    handler,
    pause,
    setPaused: (v: boolean) => (paused = v),
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    onPauseCheck: (f: () => void) => pausedCalls.push(f),
  };
}

const req = (id: string, over: Partial<HoldRequest> = {}): HoldRequest => ({
  scope: "payments",
  operationId: id,
  kind: "payments.settle",
  payload: { amount: 5 },
  requestedBy: "user-1",
  ...over,
});

describe("HeldOperationsService.hold (#338)", () => {
  it("holds an operation while the scope is paused", async () => {
    const { svc } = setup();
    const out = await svc.hold(req("op-1"));
    expect(out).toMatchObject({
      held: true,
      duplicate: false,
      operation: { status: "pending", attempts: 0 },
    });
  });

  it("does not hold when the scope is not paused, so the caller runs it directly", async () => {
    const { svc, store } = setup({ paused: false });
    expect(await svc.hold(req("op-1"))).toEqual({
      held: false,
      reason: "not-paused",
    });
    expect(await store.count("payments")).toBe(0);
  });

  it("is idempotent on operationId", async () => {
    const { svc, store } = setup();
    await svc.hold(req("op-1"));
    const again = await svc.hold(req("op-1", { payload: { amount: 999 } }));
    expect(again).toMatchObject({
      held: true,
      duplicate: true,
      operation: { payload: { amount: 5 } },
    });
    expect(await store.count("payments")).toBe(1);
  });

  it("validates input and unknown kinds", async () => {
    const { svc } = setup();
    await expect(svc.hold(req(""))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.hold(req("x", { scope: "" }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.hold(req("x", { kind: "nope" }))).rejects.toThrow(
      "No replay handler",
    );
  });

  it("caps held operations per scope but still accepts duplicates of held ones", async () => {
    const { svc } = setup();
    await svc.hold(req("1"));
    await svc.hold(req("2"));
    await svc.hold(req("3"));
    await expect(svc.hold(req("4"))).rejects.toBeInstanceOf(ConflictException);
    expect(await svc.hold(req("3"))).toMatchObject({
      held: true,
      duplicate: true,
    });
    await expect(
      svc.hold(req("5", { scope: "oracle" })),
    ).resolves.toMatchObject({ held: true });
  });
});

describe("HeldOperationsService.replay authorization and guards", () => {
  it.each([[["USER"]], [["MAINTAINER"]], [[]]])(
    "rejects non-admin %j",
    async (roles) => {
      const { svc, handler } = setup({ paused: false });
      await expect(
        svc.replay("payments", { id: "u", roles }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("refuses to replay while the scope is still paused", async () => {
    const { svc, handler } = setup({ paused: true });
    await expect(svc.replay("payments", ADMIN)).rejects.toThrow("still paused");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a concurrent replay of the same scope", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { svc, setPaused } = setup({ handlerImpl: () => gate });
    await svc.hold(req("1"));
    setPaused(false);
    const first = svc.replay("payments", ADMIN);
    await new Promise((r) => setImmediate(r));
    await expect(svc.replay("payments", ADMIN)).rejects.toThrow(
      "already running",
    );
    release();
    await expect(first).resolves.toMatchObject({ completed: 1 });
    // The lock is released afterwards.
    await expect(svc.replay("payments", ADMIN)).resolves.toMatchObject({
      completed: 0,
    });
  });
});

describe("HeldOperationsService.replay", () => {
  it("replays in the order operations were held and marks them completed", async () => {
    const { svc, store, handler, setPaused, advance } = setup();
    await svc.hold(req("a"));
    advance(1000);
    await svc.hold(req("b"));
    setPaused(false);
    const run = await svc.replay("payments", ADMIN);
    expect(handler.mock.calls.map(([o]) => o.operationId)).toEqual(["a", "b"]);
    expect(run).toMatchObject({
      completed: 2,
      failed: 0,
      expired: 0,
      remaining: 0,
      interrupted: false,
    });
    expect(await store.get("a")).toMatchObject({
      status: "completed",
      attempts: 1,
    });
  });

  it("is safe to run twice: completed operations are not replayed again", async () => {
    const { svc, handler, setPaused } = setup();
    await svc.hold(req("a"));
    setPaused(false);
    await svc.replay("payments", ADMIN);
    const second = await svc.replay("payments", ADMIN);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.results).toEqual([]);
  });

  it("keeps a failing operation pending for retry, then fails it at maxAttempts, without blocking others", async () => {
    const { svc, store, setPaused } = setup({
      handlerImpl: async (op) => {
        if (op.operationId === "bad") throw new Error("downstream 500");
      },
    });
    await svc.hold(req("bad"));
    await svc.hold(req("good"));
    setPaused(false);

    const first = await svc.replay("payments", ADMIN);
    expect(first).toMatchObject({ completed: 1, failed: 0, remaining: 1 });
    expect(first.results[0]).toEqual({
      operationId: "bad",
      outcome: "retry-later",
      detail: "downstream 500",
    });
    expect(await store.get("bad")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "downstream 500",
    });

    const second = await svc.replay("payments", ADMIN);
    expect(second).toMatchObject({ completed: 0, failed: 1, remaining: 0 });
    expect(await store.get("bad")).toMatchObject({
      status: "failed",
      attempts: 2,
    });
    expect((await svc.replay("payments", ADMIN)).results).toEqual([]);
  });

  it("records non-Error throws", async () => {
    const { svc, store, setPaused } = setup({
      handlerImpl: async () => {
        throw "boom";
      },
    });
    await svc.hold(req("a"));
    setPaused(false);
    await svc.replay("payments", ADMIN);
    expect((await store.get("a"))!.lastError).toBe("boom");
  });

  it("expires stale operations instead of replaying them", async () => {
    const { svc, store, handler, setPaused, advance } = setup();
    await svc.hold(req("old"));
    advance(25 * 60 * 60 * 1000);
    await svc.hold(req("fresh"));
    setPaused(false);
    const run = await svc.replay("payments", ADMIN);
    expect(run).toMatchObject({ expired: 1, completed: 1 });
    expect(handler.mock.calls.map(([o]) => o.operationId)).toEqual(["fresh"]);
    expect(await store.get("old")).toMatchObject({ status: "expired" });
  });

  it("stops when the scope is paused again and leaves the rest pending for the next run", async () => {
    const { svc, store, handler, setPaused, onPauseCheck } = setup();
    await svc.hold(req("a"));
    await svc.hold(req("b"));
    await svc.hold(req("c"));
    setPaused(false);

    // Pause again after the first handler has run.
    let fired = false;
    onPauseCheck(() => {
      if (!fired && handler.mock.calls.length === 1) {
        fired = true;
        setPaused(true);
      }
    });
    const run = await svc.replay("payments", ADMIN);
    expect(run).toMatchObject({
      interrupted: true,
      completed: 1,
      remaining: 2,
    });
    expect(await store.count("payments")).toBe(2);

    setPaused(false);
    const resumed = await svc.replay("payments", ADMIN);
    expect(resumed).toMatchObject({ completed: 2, interrupted: false });
    expect(handler.mock.calls.map(([o]) => o.operationId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("InMemoryHeldOperationStore", () => {
  it("returns copies so callers cannot mutate stored rows", async () => {
    const store = new InMemoryHeldOperationStore();
    const base: HeldOperation = {
      operationId: "x",
      scope: "s",
      kind: "k",
      payload: {},
      requestedBy: "u",
      heldAt: new Date(),
      status: "pending",
      attempts: 0,
    };
    const { op } = await store.insertIfAbsent(base);
    op.status = "completed";
    expect((await store.get("x"))!.status).toBe("pending");
    expect(await store.get("missing")).toBeNull();
  });
});
