import { ForbiddenException, Logger } from "@nestjs/common";
import { Role, normalizeRole } from "../common/guard/roles.enum";
import {
  assessEntry,
  buildReport,
  planRepairs,
  validatePolicy,
} from "./storage-ttl.policy";
import {
  DEFAULT_TTL_POLICY,
  LedgerTtlGateway,
  PlannedRepair,
  RepairResult,
  RepairRunSummary,
  TrackedEntry,
  TtlGatewayError,
  TtlPolicy,
  TtlReport,
} from "./storage-ttl.types";

export interface StorageTtlOptions {
  policy?: TtlPolicy;
  /** Attempts per repair for transient gateway errors. Default 3. */
  maxAttempts?: number;
  /** Base backoff; attempt n waits base * 2^(n-1). Default 200ms. */
  backoffMs?: number;
  /** Cap on repairs executed per run, so one run cannot flood the network. Default 50. */
  maxRepairsPerRun?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, "log" | "warn" | "error">;
}

export interface RepairActor {
  id: string;
  roles: string[];
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Monitors TTLs of tracked storage entries and repairs them (#337).
 *
 * - `scan` is read-only and safe for any monitoring caller.
 * - `repair` mutates chain state, so it needs an ADMIN actor, re-reads the
 *   current TTLs first (so a repeated or concurrent run skips entries that were
 *   already fixed), retries transient failures with backoff, and keeps going
 *   after an individual failure so one bad entry cannot block the rest.
 */
export class StorageTtlService {
  private readonly policy: TtlPolicy;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxRepairsPerRun: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Logger, "log" | "warn" | "error">;

  constructor(
    private readonly gateway: LedgerTtlGateway,
    options: StorageTtlOptions = {},
  ) {
    this.policy = validatePolicy(options.policy ?? DEFAULT_TTL_POLICY);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffMs = options.backoffMs ?? 200;
    this.maxRepairsPerRun = Math.max(1, options.maxRepairsPerRun ?? 50);
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? new Logger(StorageTtlService.name);
  }

  async scan(entries: TrackedEntry[]): Promise<TtlReport> {
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.key)) throw new Error(`Duplicate tracked key: ${e.key}`);
      seen.add(e.key);
    }
    const currentLedger = await this.gateway.getCurrentLedger();
    const ttls = entries.length
      ? await this.gateway.getTtls(entries.map((e) => e.key))
      : {};
    const assessments = entries.map((e) =>
      assessEntry(e, ttls[e.key], currentLedger, this.policy),
    );
    return buildReport(assessments, currentLedger);
  }

  async repair(
    entries: TrackedEntry[],
    actor: RepairActor,
    options: { dryRun?: boolean } = {},
  ): Promise<RepairRunSummary> {
    this.assertAdmin(actor);
    const dryRun = options.dryRun ?? false;

    const report = await this.scan(entries);
    const plan = planRepairs(report, this.maxRepairsPerRun);
    const results: RepairResult[] = [];

    for (const planned of plan.repairs) {
      if (dryRun) {
        results.push({
          key: planned.key,
          action: planned.action,
          outcome: "dry-run",
          attempts: 0,
          detail: planned.reason,
        });
        continue;
      }
      results.push(await this.execute(planned));
    }

    const count = (o: RepairResult["outcome"]) =>
      results.filter((r) => r.outcome === o).length;
    const summary: RepairRunSummary = {
      dryRun,
      plan,
      results,
      repaired: count("repaired"),
      failed: count("failed"),
      skipped: count("skipped"),
    };
    this.logger.log(
      `TTL repair by ${actor.id}: dryRun=${dryRun} repaired=${summary.repaired} failed=${summary.failed} skipped=${summary.skipped} deferred=${plan.deferred.length}`,
    );
    return summary;
  }

  private assertAdmin(actor: RepairActor): void {
    const roles = (actor.roles ?? []).map((r) => normalizeRole(r));
    if (!roles.includes(Role.ADMIN)) {
      throw new ForbiddenException("Only an ADMIN may repair storage TTLs");
    }
  }

  /** Re-checks the entry right before acting so repeated runs are idempotent. */
  private async execute(planned: PlannedRepair): Promise<RepairResult> {
    let attempts = 0;
    let lastError = "unknown error";

    while (attempts < this.maxAttempts) {
      attempts++;
      try {
        const [current, ledger] = await Promise.all([
          this.gateway.getTtls([planned.key]),
          this.gateway.getCurrentLedger(),
        ]);
        const ttl = current[planned.key];
        const archived =
          !ttl || ttl.archived || (ttl.liveUntilLedger ?? -1) < ledger;
        const remaining =
          ttl?.liveUntilLedger != null ? ttl.liveUntilLedger - ledger : -1;

        // Each step is conditional on current state so a retry after a partial
        // failure (restored but not yet extended) finishes the job instead of
        // skipping it.
        if (!archived && remaining >= this.policy.warnBelowLedgers) {
          const detail =
            planned.action === "restore"
              ? "Already restored by another run"
              : "Already renewed by another run";
          return {
            key: planned.key,
            action: planned.action,
            outcome: "skipped",
            attempts,
            detail,
          };
        }
        if (archived) {
          await this.gateway.restore(planned.key);
        }
        // A restore only revives the entry briefly; extend so it does not re-archive.
        await this.gateway.extendTtl(planned.key, this.policy.extendToLedgers);
        return {
          key: planned.key,
          action: planned.action,
          outcome: "repaired",
          attempts,
          detail: planned.reason,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const transient = err instanceof TtlGatewayError && err.transient;
        if (!transient) break;
        if (attempts < this.maxAttempts) {
          await this.sleep(this.backoffMs * 2 ** (attempts - 1));
        }
      }
    }

    this.logger.error(
      `TTL ${planned.action} failed for ${planned.key} after ${attempts} attempt(s): ${lastError}`,
    );
    return {
      key: planned.key,
      action: planned.action,
      outcome: "failed",
      attempts,
      detail: lastError,
    };
  }
}
