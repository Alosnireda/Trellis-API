/**
 * Operations held during an emergency pause and replayed after resume (#338).
 * Pure types plus an in-memory store; production wiring can supply a durable
 * `HeldOperationStore` (for example TypeORM) without touching the service.
 */

export type HeldOperationStatus =
  "pending" | "completed" | "failed" | "expired";

export interface HeldOperation {
  /** Caller-supplied idempotency key; holding the same id twice is a no-op. */
  operationId: string;
  scope: string;
  /** Handler selector, e.g. "payments.settle". */
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  heldAt: Date;
  status: HeldOperationStatus;
  attempts: number;
  lastError?: string;
  completedAt?: Date;
}

export interface HeldOperationStore {
  /** Inserts unless `operationId` exists; returns the stored row either way. */
  insertIfAbsent(
    op: HeldOperation,
  ): Promise<{ op: HeldOperation; created: boolean }>;
  /** Pending operations for a scope, oldest first. */
  listPending(scope: string): Promise<HeldOperation[]>;
  count(scope: string): Promise<number>;
  update(op: HeldOperation): Promise<void>;
  get(operationId: string): Promise<HeldOperation | null>;
}

export class InMemoryHeldOperationStore implements HeldOperationStore {
  private readonly rows = new Map<string, HeldOperation>();

  async insertIfAbsent(op: HeldOperation) {
    const existing = this.rows.get(op.operationId);
    if (existing) return { op: { ...existing }, created: false };
    this.rows.set(op.operationId, { ...op });
    return { op: { ...op }, created: true };
  }

  async listPending(scope: string) {
    return [...this.rows.values()]
      .filter((o) => o.scope === scope && o.status === "pending")
      .sort((a, b) => a.heldAt.getTime() - b.heldAt.getTime())
      .map((o) => ({ ...o }));
  }

  async count(scope: string) {
    return [...this.rows.values()].filter(
      (o) => o.scope === scope && o.status === "pending",
    ).length;
  }

  async update(op: HeldOperation) {
    this.rows.set(op.operationId, { ...op });
  }

  async get(operationId: string) {
    const row = this.rows.get(operationId);
    return row ? { ...row } : null;
  }
}

/** Runs one held operation. Throw to signal failure; the service decides on retries. */
export type HeldOperationHandler = (op: HeldOperation) => Promise<void>;

export interface ReplayResult {
  operationId: string;
  outcome: HeldOperationStatus | "retry-later" | "duplicate-skipped";
  detail?: string;
}

export interface ReplaySummary {
  scope: string;
  /** True when the scope was paused again mid-replay and the run stopped early. */
  interrupted: boolean;
  completed: number;
  failed: number;
  expired: number;
  /** Operations still pending after this run (retry-later plus unprocessed). */
  remaining: number;
  results: ReplayResult[];
}
