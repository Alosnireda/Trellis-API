import {
  DEFAULT_TTL_POLICY,
  EntryAssessment,
  EntryTtl,
  PlannedRepair,
  RepairPlan,
  TrackedEntry,
  TtlHealth,
  TtlPolicy,
  TtlReport,
} from "./storage-ttl.types";

/** Rejects policies that would make every entry look unhealthy or loop on renewal. */
export function validatePolicy(policy: TtlPolicy): TtlPolicy {
  const {
    warnBelowLedgers: warn,
    criticalBelowLedgers: crit,
    extendToLedgers: ext,
  } = policy;
  const ok = [warn, crit, ext].every((n) => Number.isInteger(n) && n > 0);
  if (!ok) throw new Error("TTL policy values must be positive integers");
  if (crit >= warn)
    throw new Error("criticalBelowLedgers must be below warnBelowLedgers");
  if (ext <= warn)
    throw new Error(
      "extendToLedgers must exceed warnBelowLedgers or renewals never leave the warning band",
    );
  return policy;
}

export function assessEntry(
  entry: TrackedEntry,
  ttl: EntryTtl | null | undefined,
  currentLedger: number,
  policy: TtlPolicy = DEFAULT_TTL_POLICY,
): EntryAssessment {
  const make = (
    health: TtlHealth,
    remaining: number | null,
    detail: string,
  ): EntryAssessment => ({
    entry,
    health,
    remainingLedgers: remaining,
    detail,
  });

  if (ttl === undefined || ttl === null) {
    return make("unknown", null, "No TTL information returned for this key");
  }
  if (ttl.archived) {
    return entry.durability === "persistent"
      ? make(
          "archived",
          null,
          "Persistent entry is archived and can be restored",
        )
      : make(
          "expired",
          null,
          "Temporary entry has expired and cannot be restored",
        );
  }
  if (ttl.liveUntilLedger === null || !Number.isFinite(ttl.liveUntilLedger)) {
    return make("unknown", null, "Gateway returned no live-until ledger");
  }

  const remaining = ttl.liveUntilLedger - currentLedger;
  if (remaining < 0) {
    // Expired but not yet reported archived; a persistent entry is recoverable.
    return entry.durability === "persistent"
      ? make(
          "archived",
          null,
          "Persistent entry passed its live-until ledger; restore it",
        )
      : make(
          "expired",
          null,
          "Temporary entry has expired and cannot be restored",
        );
  }
  if (remaining < policy.criticalBelowLedgers) {
    return make("critical", remaining, `Only ${remaining} ledgers remain`);
  }
  if (remaining < policy.warnBelowLedgers) {
    return make(
      "expiring",
      remaining,
      `${remaining} ledgers remain; renewal due`,
    );
  }
  return make("healthy", remaining, `${remaining} ledgers remain`);
}

export function buildReport(
  assessments: EntryAssessment[],
  currentLedger: number,
): TtlReport {
  const counts: Record<TtlHealth, number> = {
    healthy: 0,
    expiring: 0,
    critical: 0,
    archived: 0,
    expired: 0,
    unknown: 0,
  };
  for (const a of assessments) counts[a.health]++;
  return {
    currentLedger,
    assessments,
    counts,
    needsAttention: assessments.some((a) => a.health !== "healthy"),
  };
}

/** Severity order: most urgent repairs run first so a capped run saves the worst. */
const REPAIR_PRIORITY: Record<string, number> = {
  archived: 0,
  critical: 1,
  expiring: 2,
};

export function planRepairs(
  report: TtlReport,
  maxRepairs = Infinity,
): RepairPlan {
  const repairs: PlannedRepair[] = [];
  const unrecoverable: RepairPlan["unrecoverable"] = [];
  const prioritised: Array<{ p: number; r: PlannedRepair }> = [];

  for (const a of report.assessments) {
    switch (a.health) {
      case "archived":
        prioritised.push({
          p: 0,
          r: { key: a.entry.key, action: "restore", reason: a.detail },
        });
        break;
      case "critical":
      case "expiring":
        prioritised.push({
          p: REPAIR_PRIORITY[a.health],
          r: { key: a.entry.key, action: "extend", reason: a.detail },
        });
        break;
      case "expired":
        unrecoverable.push({ key: a.entry.key, reason: a.detail });
        break;
      case "unknown":
        unrecoverable.push({
          key: a.entry.key,
          reason: `${a.detail}; verify the key is correct`,
        });
        break;
      default:
        break;
    }
  }

  prioritised.sort((x, y) => x.p - y.p || x.r.key.localeCompare(y.r.key));
  for (const { r } of prioritised) repairs.push(r);
  return {
    repairs: repairs.slice(0, maxRepairs),
    unrecoverable,
    deferred: repairs.slice(maxRepairs),
  };
}
