import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { Role, normalizeRole } from "../../common/guard/roles.enum";
import {
  HeldOperation,
  HeldOperationHandler,
  HeldOperationStore,
  ReplayResult,
  ReplaySummary,
} from "./held-operations.types";

export interface PauseChecker {
  isOperationPaused(
    scope: string,
  ): Promise<{ paused: boolean; reason?: string }>;
}

export interface HeldOperationsOptions {
  /** Held operations older than this are expired, not replayed. Default 24h. */
  maxAgeMs?: number;
  /** Replay attempts before an operation is marked failed. Default 3. */
  maxAttempts?: number;
  /** Cap on pending operations per scope so a long pause cannot grow without bound. Default 1000. */
  maxHeldPerScope?: number;
  now?: () => Date;
  logger?: Pick<Logger, "log" | "warn" | "error">;
}

export interface HoldRequest {
  scope: string;
  operationId: string;
  kind: string;
  payload: Record<string, unknown>;
  requestedBy: string;
}

export type HoldOutcome =
  | { held: true; duplicate: boolean; operation: HeldOperation }
  | { held: false; reason: "not-paused" };

/**
 * Holds operations that arrive while a scope is paused and replays them, in
 * order, once it is resumed (#338).
 *
 * Safety properties:
 * - Holding is idempotent on `operationId`, so a client retry cannot double-queue.
 * - Replay is explicit and ADMIN-only; resuming a pause never silently runs
 *   money-moving work.
 * - Replay re-checks the pause before every operation and stops if the scope
 *   was paused again, leaving the rest pending.
 * - Operations are marked completed one by one, so a crash mid-replay resumes
 *   from where it stopped. Handlers must still be idempotent on `operationId`,
 *   because a crash between the handler finishing and the status write replays
 *   that one operation.
 * - Stale operations expire instead of replaying old intent.
 * - One replay per scope at a time.
 */
export class HeldOperationsService {
  private readonly maxAgeMs: number;
  private readonly maxAttempts: number;
  private readonly maxHeldPerScope: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Logger, "log" | "warn" | "error">;
  private readonly replaying = new Set<string>();

  constructor(
    private readonly store: HeldOperationStore,
    private readonly pause: PauseChecker,
    private readonly handlers: Record<string, HeldOperationHandler>,
    options: HeldOperationsOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.maxHeldPerScope = Math.max(1, options.maxHeldPerScope ?? 1000);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? new Logger(HeldOperationsService.name);
  }

  async hold(req: HoldRequest): Promise<HoldOutcome> {
    if (!req.operationId || !req.scope || !req.kind) {
      throw new BadRequestException("scope, operationId and kind are required");
    }
    if (!this.handlers[req.kind]) {
      throw new BadRequestException(
        `No replay handler registered for '${req.kind}'`,
      );
    }

    const state = await this.pause.isOperationPaused(req.scope);
    if (!state.paused) return { held: false, reason: "not-paused" };

    const existing = await this.store.get(req.operationId);
    if (
      !existing &&
      (await this.store.count(req.scope)) >= this.maxHeldPerScope
    ) {
      throw new ConflictException(
        `Too many operations held for scope '${req.scope}'; try again after resume`,
      );
    }

    const { op, created } = await this.store.insertIfAbsent({
      ...req,
      heldAt: this.now(),
      status: "pending",
      attempts: 0,
    });
    return { held: true, duplicate: !created, operation: op };
  }

  async replay(
    scope: string,
    actor: { id: string; roles: string[] },
  ): Promise<ReplaySummary> {
    const roles = (actor.roles ?? []).map((r) => normalizeRole(r));
    if (!roles.includes(Role.ADMIN)) {
      throw new ForbiddenException("Only an ADMIN may replay held operations");
    }
    if ((await this.pause.isOperationPaused(scope)).paused) {
      throw new ConflictException(
        `Scope '${scope}' is still paused; resume it before replaying`,
      );
    }
    if (this.replaying.has(scope)) {
      throw new ConflictException(
        `A replay for scope '${scope}' is already running`,
      );
    }

    this.replaying.add(scope);
    try {
      return await this.runReplay(scope, actor.id);
    } finally {
      this.replaying.delete(scope);
    }
  }

  private async runReplay(
    scope: string,
    actorId: string,
  ): Promise<ReplaySummary> {
    const pending = await this.store.listPending(scope);
    const summary: ReplaySummary = {
      scope,
      interrupted: false,
      completed: 0,
      failed: 0,
      expired: 0,
      remaining: 0,
      results: [],
    };

    for (let i = 0; i < pending.length; i++) {
      const op = pending[i];
      // Paused again mid-replay: stop and leave this and later operations pending.
      if ((await this.pause.isOperationPaused(scope)).paused) {
        summary.interrupted = true;
        summary.remaining = pending.length - i;
        break;
      }

      if (this.now().getTime() - op.heldAt.getTime() > this.maxAgeMs) {
        op.status = "expired";
        op.lastError = "Held longer than the maximum age; not replayed";
        await this.store.update(op);
        summary.expired++;
        summary.results.push({
          operationId: op.operationId,
          outcome: "expired",
          detail: op.lastError,
        });
        continue;
      }

      const result = await this.runOne(op);
      summary.results.push(result);
      if (result.outcome === "completed") summary.completed++;
      else if (result.outcome === "failed") summary.failed++;
      else if (result.outcome === "retry-later") summary.remaining++;
    }

    this.logger.log(
      `Held-operation replay for '${scope}' by ${actorId}: completed=${summary.completed} failed=${summary.failed} expired=${summary.expired} remaining=${summary.remaining} interrupted=${summary.interrupted}`,
    );
    return summary;
  }

  private async runOne(op: HeldOperation): Promise<ReplayResult> {
    op.attempts++;
    try {
      await this.handlers[op.kind](op);
      op.status = "completed";
      op.completedAt = this.now();
      op.lastError = undefined;
      await this.store.update(op);
      return { operationId: op.operationId, outcome: "completed" };
    } catch (err) {
      op.lastError = err instanceof Error ? err.message : String(err);
      const exhausted = op.attempts >= this.maxAttempts;
      if (exhausted) op.status = "failed";
      await this.store.update(op);
      if (exhausted) {
        this.logger.error(
          `Held operation ${op.operationId} failed after ${op.attempts} attempt(s): ${op.lastError}`,
        );
        return {
          operationId: op.operationId,
          outcome: "failed",
          detail: op.lastError,
        };
      }
      return {
        operationId: op.operationId,
        outcome: "retry-later",
        detail: op.lastError,
      };
    }
  }
}
