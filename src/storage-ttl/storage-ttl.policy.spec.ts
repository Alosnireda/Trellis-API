import {
  assessEntry,
  buildReport,
  planRepairs,
  validatePolicy,
} from "./storage-ttl.policy";
import { DEFAULT_TTL_POLICY, TrackedEntry } from "./storage-ttl.types";

const P = DEFAULT_TTL_POLICY;
const NOW = 1_000_000;
const persistent = (key: string): TrackedEntry => ({
  key,
  durability: "persistent",
});
const temporary = (key: string): TrackedEntry => ({
  key,
  durability: "temporary",
});

describe("validatePolicy", () => {
  it("accepts the default policy", () => {
    expect(validatePolicy(P)).toBe(P);
  });
  it.each([
    [{ ...P, warnBelowLedgers: 0 }, "positive integers"],
    [{ ...P, extendToLedgers: 1.5 }, "positive integers"],
    [
      { ...P, criticalBelowLedgers: P.warnBelowLedgers },
      "below warnBelowLedgers",
    ],
    [
      { ...P, extendToLedgers: P.warnBelowLedgers },
      "must exceed warnBelowLedgers",
    ],
  ])("rejects an inconsistent policy %#", (policy, message) => {
    expect(() => validatePolicy(policy)).toThrow(message);
  });
});

describe("assessEntry", () => {
  it("classifies by remaining ledgers at the boundaries", () => {
    const at = (remaining: number) =>
      assessEntry(persistent("k"), { liveUntilLedger: NOW + remaining }, NOW, P)
        .health;
    expect(at(P.warnBelowLedgers)).toBe("healthy");
    expect(at(P.warnBelowLedgers - 1)).toBe("expiring");
    expect(at(P.criticalBelowLedgers)).toBe("expiring");
    expect(at(P.criticalBelowLedgers - 1)).toBe("critical");
    expect(at(0)).toBe("critical");
  });

  it("reports remaining ledgers only for live entries", () => {
    expect(
      assessEntry(persistent("k"), { liveUntilLedger: NOW + 500 }, NOW)
        .remainingLedgers,
    ).toBe(500);
    expect(
      assessEntry(
        persistent("k"),
        { liveUntilLedger: null, archived: true },
        NOW,
      ).remainingLedgers,
    ).toBeNull();
  });

  it("treats archived persistent entries as restorable and temporary ones as lost", () => {
    expect(
      assessEntry(
        persistent("k"),
        { liveUntilLedger: null, archived: true },
        NOW,
      ).health,
    ).toBe("archived");
    expect(
      assessEntry(
        temporary("k"),
        { liveUntilLedger: null, archived: true },
        NOW,
      ).health,
    ).toBe("expired");
  });

  it("handles entries already past their live-until ledger", () => {
    expect(
      assessEntry(persistent("k"), { liveUntilLedger: NOW - 1 }, NOW).health,
    ).toBe("archived");
    expect(
      assessEntry(temporary("k"), { liveUntilLedger: NOW - 1 }, NOW).health,
    ).toBe("expired");
  });

  it("returns unknown for missing or unusable TTL data", () => {
    expect(assessEntry(persistent("k"), undefined, NOW).health).toBe("unknown");
    expect(assessEntry(persistent("k"), null, NOW).health).toBe("unknown");
    expect(
      assessEntry(persistent("k"), { liveUntilLedger: null }, NOW).health,
    ).toBe("unknown");
    expect(
      assessEntry(persistent("k"), { liveUntilLedger: Number.NaN }, NOW).health,
    ).toBe("unknown");
  });
});

describe("buildReport and planRepairs", () => {
  const assessments = [
    assessEntry(
      persistent("b-expiring"),
      { liveUntilLedger: NOW + 1000 + P.criticalBelowLedgers },
      NOW,
    ),
    assessEntry(persistent("a-critical"), { liveUntilLedger: NOW + 10 }, NOW),
    assessEntry(
      persistent("z-archived"),
      { liveUntilLedger: null, archived: true },
      NOW,
    ),
    assessEntry(
      temporary("lost"),
      { liveUntilLedger: null, archived: true },
      NOW,
    ),
    assessEntry(persistent("missing"), null, NOW),
    assessEntry(
      persistent("ok"),
      { liveUntilLedger: NOW + P.extendToLedgers },
      NOW,
    ),
  ];
  const report = buildReport(assessments, NOW);

  it("counts every health bucket and flags attention", () => {
    expect(report.counts).toEqual({
      healthy: 1,
      expiring: 1,
      critical: 1,
      archived: 1,
      expired: 1,
      unknown: 1,
    });
    expect(report.needsAttention).toBe(true);
    expect(buildReport([assessments[5]], NOW).needsAttention).toBe(false);
  });

  it("plans restores first, then critical, then expiring, and flags unrecoverable entries", () => {
    const plan = planRepairs(report);
    expect(plan.repairs.map((r) => `${r.action}:${r.key}`)).toEqual([
      "restore:z-archived",
      "extend:a-critical",
      "extend:b-expiring",
    ]);
    expect(plan.unrecoverable.map((u) => u.key).sort()).toEqual([
      "lost",
      "missing",
    ]);
    expect(
      plan.unrecoverable.find((u) => u.key === "missing")!.reason,
    ).toContain("verify the key");
    expect(plan.deferred).toEqual([]);
  });

  it("defers the least urgent repairs when capped", () => {
    const plan = planRepairs(report, 2);
    expect(plan.repairs.map((r) => r.key)).toEqual([
      "z-archived",
      "a-critical",
    ]);
    expect(plan.deferred.map((r) => r.key)).toEqual(["b-expiring"]);
  });

  it("plans nothing for a fully healthy set", () => {
    expect(planRepairs(buildReport([assessments[5]], NOW))).toEqual({
      repairs: [],
      unrecoverable: [],
      deferred: [],
    });
  });
});
