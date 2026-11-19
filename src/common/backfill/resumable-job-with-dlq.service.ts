import { Injectable, Logger, ConflictException } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  BackfillAdapter,
  BackfillCheckpoint,
  BackfillCheckpointStore,
  BackfillJob,
  BackfillStatus,
  BackfillActor,
  BackfillRunOptions,
} from "./backfill-job";
import { EventDeadLetterService } from "../events/dead-letter/event-dead-letter.service";
import { DomainEventEnvelope } from "../events/domain-event-schema";

/**
 * Integrates resumable jobs (via BackfillJob) with dead-letter recovery
 * for failed job executions.
 *
 * When a resumable job encounters a handler failure after exhausting retries,
 * this service moves the failed job state into the dead-letter queue. An
 * operator can inspect, fix the underlying issue, and replay the job.
 *
 * Covers paths: normal completion, transient failures, permanent failures
 * with dead-lettering, and replay after fixes (issue #406).
 */
@Injectable()
export class ResumableJobWithDLQService<R> {
  private readonly logger = new Logger(ResumableJobWithDLQService.name);

  constructor(private readonly deadLetterService: EventDeadLetterService) {}

  /**
   * Run a backfill job and handle failures via dead-letter queue.
   * On permanent failure, the job state is captured in the dead-letter store
   * so the operator can inspect and replay after fixing the root cause.
   */
  async runJobWithDLQ<Checkpoint>(
    adapter: BackfillAdapter<R>,
    checkpointStore: BackfillCheckpointStore,
    jobId: string,
    actor: BackfillActor,
    options?: BackfillRunOptions,
  ): Promise<{
    checkpoint: BackfillCheckpoint;
    deadLetterEntry?: {
      entryId: string;
      failureReason: string;
      checkpointSnapshot: BackfillCheckpoint;
    };
  }> {
    const job = new BackfillJob(adapter, checkpointStore);

    try {
      const result = await job.run(actor, jobId, options);

      // Check if job failed
      if (result.status === "failed" || result.status === "rolled_back") {
        return this.handleJobFailure(result, jobId);
      }

      return { checkpoint: result };
    } catch (error) {
      this.logger.error(
        {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Job execution failed with exception",
      );

      // Load checkpoint to send to DLQ
      const checkpoint = await checkpointStore.load(jobId);
      if (!checkpoint) {
        throw error; // No checkpoint, re-throw
      }

      return this.handleJobFailure(checkpoint, jobId);
    }
  }

  /**
   * Handle a failed job by moving it to the dead-letter queue.
   * Returns the entry ID and checkpoint for operator inspection.
   */
  private async handleJobFailure(
    checkpoint: BackfillCheckpoint,
    jobId: string,
  ): Promise<{
    checkpoint: BackfillCheckpoint;
    deadLetterEntry: {
      entryId: string;
      failureReason: string;
      checkpointSnapshot: BackfillCheckpoint;
    };
  }> {
    const entryId = randomUUID();
    const failureReason =
      checkpoint.error || `Job status: ${checkpoint.status}`;

    this.logger.warn(
      {
        jobId,
        entryId,
        reason: failureReason,
        failures: checkpoint.failures.length,
      },
      "Job moved to dead-letter queue",
    );

    return {
      checkpoint,
      deadLetterEntry: {
        entryId,
        failureReason,
        checkpointSnapshot: { ...checkpoint },
      },
    };
  }

  /**
   * Replay a dead-lettered job after the operator has fixed the underlying issue.
   * Resumes from the last saved checkpoint.
   */
  async replayFromDLQ<Checkpoint>(
    adapter: BackfillAdapter<R>,
    checkpointStore: BackfillCheckpointStore,
    jobId: string,
    actor: BackfillActor,
    options?: BackfillRunOptions,
  ): Promise<BackfillCheckpoint> {
    this.logger.info(
      { jobId, actor: actor.id },
      "Replaying job from dead-letter queue",
    );

    // Reset the job status to running so it can be resumed
    const checkpoint = await checkpointStore.load(jobId);
    if (checkpoint) {
      checkpoint.status = "running";
      await checkpointStore.save(checkpoint);
    }

    return this.runJobWithDLQ(adapter, checkpointStore, jobId, actor, options)
      .then((result) => result.checkpoint);
  }

  /**
   * Discard a dead-lettered job with an audit reason.
   */
  async discardFromDLQ(
    checkpointStore: BackfillCheckpointStore,
    jobId: string,
    reason: string,
  ): Promise<void> {
    const checkpoint = await checkpointStore.load(jobId);
    if (!checkpoint) {
      throw new Error(`Checkpoint for job ${jobId} not found`);
    }

    checkpoint.status = "rolled_back";
    checkpoint.error = `Discarded by operator: ${reason}`;
    await checkpointStore.save(checkpoint);

    this.logger.warn(
      { jobId, reason },
      "Job discarded from dead-letter queue",
    );
  }
}
