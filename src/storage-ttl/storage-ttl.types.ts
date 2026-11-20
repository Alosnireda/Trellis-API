/**
 * Storage TTL renewal monitoring and repair (#337).
 *
 * Soroban ledger entries expire at `liveUntilLedger`. Persistent entries are
 * archived (recoverable by a restore); temporary ones are gone for good. These
 * types describe what the monitor observes and what the repair tooling does.
 */

export type StorageDurability = "persistent" | "temporary";

export interface TrackedEntry {
  /** Stable identifier, e.g. `<contractId>:<keyHash>`. Never a secret. */
  key: string;
  durability: StorageDurability;
  /** Operators' label for alerts, e.g. "vault-balances". */
  label?: string;
}

export interface EntryTtl {
  /** Last ledger the entry is live for; `null` when archived or absent. */
  liveUntilLedger: number | null;
  /** True when the entry exists but has been archived (restorable). */
  archived?: boolean;
}

export type TtlHealth =
  "healthy" | "expiring" | "critical" | "archived" | "expired" | "unknown";

export interface TtlPolicy {
  /** Renew when fewer than this many ledgers remain. */
  warnBelowLedgers: number;
  /** Escalate when fewer than this many ledgers remain. */
  criticalBelowLedgers: number;
  /** Target remaining lifetime after a renewal, in ledgers. */
  extendToLedgers: number;
}

/** ~5s per ledger: warn at 7 days, critical at 1 day, renew to 30 days. */
export const DEFAULT_TTL_POLICY: TtlPolicy = {
  warnBelowLedgers: 120_960,
  criticalBelowLedgers: 17_280,
  extendToLedgers: 518_400,
};

export interface EntryAssessment {
  entry: TrackedEntry;
  health: TtlHealth;
  /** Ledgers left; `null` unless the entry is live. */
  remainingLedgers: number | null;
  detail: string;
}

export interface TtlReport {
  currentLedger: number;
  assessments: EntryAssessment[];
  counts: Record<TtlHealth, number>;
  /** True when anything needs a renewal or a restore, or is lost. */
  needsAttention: boolean;
}

export type RepairActionType = "extend" | "restore";

export interface PlannedRepair {
  key: string;
  action: RepairActionType;
  reason: string;
}

export interface RepairPlan {
  repairs: PlannedRepair[];
  /** Entries that cannot be repaired and need human follow-up. */
  unrecoverable: Array<{ key: string; reason: string }>;
  /** Repairs left out because the per-run cap was reached. */
  deferred: PlannedRepair[];
}

export type RepairOutcome = "repaired" | "skipped" | "failed" | "dry-run";

export interface RepairResult {
  key: string;
  action: RepairActionType;
  outcome: RepairOutcome;
  attempts: number;
  detail: string;
}

export interface RepairRunSummary {
  dryRun: boolean;
  plan: RepairPlan;
  results: RepairResult[];
  repaired: number;
  failed: number;
  skipped: number;
}

/** Port to the chain. Implementations wrap the Soroban RPC. */
export interface LedgerTtlGateway {
  getCurrentLedger(): Promise<number>;
  /** Returns one entry per requested key; absent keys map to `null`. */
  getTtls(keys: string[]): Promise<Record<string, EntryTtl | null>>;
  extendTtl(key: string, extendToLedgers: number): Promise<void>;
  restore(key: string): Promise<void>;
}

export class TtlGatewayError extends Error {
  constructor(
    message: string,
    /** Transient errors (timeouts, 5xx) are retried; permanent ones are not. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "TtlGatewayError";
  }
}
