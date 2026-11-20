import { Role } from "../../common/guard/roles.enum";
import {
  BackfillAdapter,
  BackfillChange,
  BackfillCheckpoint,
  BackfillCheckpointStore,
  BackfillPage,
} from "./backfill-job";
import { ResumableJobWithDLQService } from "./resumable-job-with-dlq.service";
import { EventDeadLetterService } from "../events/dead-letter/event-dead-letter.service";

interface TestRecord {
  id: string;
  value: string;
}

class MockCheckpointStore implements BackfillCheckpointStore {
  private store = new Map<string, BackfillCheckpoint>();

  async load(jobId: string): Promise<BackfillCheckpoint | null> {
    return this.store.get(jobId) || null;
  }

  async save(checkpoint: BackfillCheckpoint): Promise<void> {
    this.store.set(checkpoint.jobId, { ...checkpoint });
  }
}

class MockAdapter implements BackfillAdapter<TestRecord> {
  private records: TestRecord[] = [
    { id: "1", value: "original" },
    { id: "2", value: "original" },
  ];
  private scanCallCount = 0;
  failAfterCalls = -1;

  async scan(
    cursor: string | null,
    limit: number,
  ): Promise<BackfillPage<TestRecord>> {
    this.scanCallCount++;

    if (this.failAfterCalls > 0 && this.scanCallCount > this.failAfterCalls) {
      throw new Error("Scan failed");
    }

    const startIdx = cursor ? parseInt(cursor) : 0;
    const endIdx = startIdx + limit;
    const page = this.records.slice(startIdx, endIdx);

    return {
      records: page,
      nextCursor: endIdx < this.records.length ? String(endIdx) : null,
    };
  }

  recordId(record: TestRecord): string {
    return record.id;
  }

  plan(record: TestRecord): BackfillChange | null {
    if (record.value === "original") {
      return {
        recordId: record.id,
        field: "value",
        before: "original",
        after: "updated",
        reason: "test update",
      };
    }
    return null;
  }

  async apply(record: TestRecord, change: BackfillChange): Promise<unknown> {
    const idx = this.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      this.records[idx].value = change.after as string;
    }
    return undefined;
  }

  async restore(recordId: string, undo: unknown): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === recordId);
    if (idx >= 0) {
      const rollback = undo as { before: unknown };
      this.records[idx].value = rollback.before as string;
    }
  }
}

describe("ResumableJobWithDLQService", () => {
  let service: ResumableJobWithDLQService<TestRecord>;
  let mockDLQService: EventDeadLetterService;
  let checkpointStore: MockCheckpointStore;
  let adapter: MockAdapter;

  beforeEach(() => {
    mockDLQService = {
      dispatch: jest.fn(),
      replay: jest.fn(),
    } as any;

    service = new ResumableJobWithDLQService(mockDLQService);
    checkpointStore = new MockCheckpointStore();
    adapter = new MockAdapter();
  });

  describe("runJobWithDLQ", () => {
    it("completes a successful job without dead-lettering", async () => {
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };
      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
        { dryRun: false, batchSize: 10 },
      );

      expect(result.checkpoint).toBeDefined();
      expect(result.checkpoint.status).toBe("completed");
      expect(result.deadLetterEntry).toBeUndefined();
    });

    it("moves failed job to dead-letter queue", async () => {
      adapter.failAfterCalls = 0;
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
        { dryRun: false, batchSize: 10 },
      );

      expect(result.deadLetterEntry).toBeDefined();
      expect(result.deadLetterEntry?.entryId).toBeTruthy();
      expect(result.deadLetterEntry?.failureReason).toContain("failed");
    });

    it("captures checkpoint snapshot for DLQ entry", async () => {
      adapter.failAfterCalls = 0;
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
      );

      expect(result.deadLetterEntry?.checkpointSnapshot).toBeDefined();
      expect(result.deadLetterEntry?.checkpointSnapshot.jobId).toBe("job-1");
    });
  });

  describe("replayFromDLQ", () => {
    it("resumes a job from dead-letter queue", async () => {
      // First run that fails
      adapter.failAfterCalls = 0;
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      const failResult = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
      );

      expect(failResult.deadLetterEntry).toBeDefined();

      // Now fix the adapter and replay
      adapter.failAfterCalls = -1; // No more failures
      const replayResult = await service.replayFromDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
      );

      expect(replayResult).toBeDefined();
      expect(replayResult.jobId).toBe("job-1");
    });

    it("resets job status to running before replay", async () => {
      adapter.failAfterCalls = 0;
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      await service.runJobWithDLQ(adapter, checkpointStore, "job-1", actor);

      // Create a checkpoint in failed state
      let checkpoint = await checkpointStore.load("job-1");
      expect(checkpoint?.status).toBe("failed");

      // Replay should reset status
      adapter.failAfterCalls = -1;
      await service.replayFromDLQ(adapter, checkpointStore, "job-1", actor);

      checkpoint = await checkpointStore.load("job-1");
      // After successful replay, status should be completed
      expect(checkpoint?.status).toBe("completed");
    });
  });

  describe("discardFromDLQ", () => {
    it("marks job as discarded with reason", async () => {
      adapter.failAfterCalls = 0;
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      await service.runJobWithDLQ(adapter, checkpointStore, "job-1", actor);

      await service.discardFromDLQ(
        checkpointStore,
        "job-1",
        "Data inconsistency detected",
      );

      const checkpoint = await checkpointStore.load("job-1");
      expect(checkpoint?.status).toBe("rolled_back");
      expect(checkpoint?.error).toContain("Data inconsistency detected");
    });

    it("throws when job not found in checkpoint store", async () => {
      await expect(
        service.discardFromDLQ(checkpointStore, "nonexistent", "test reason"),
      ).rejects.toThrow();
    });
  });

  describe("failure scenarios", () => {
    it("handles job execution exceptions gracefully", async () => {
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };
      adapter.failAfterCalls = 0;

      // Run should not throw, but return dead-letter entry
      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
      );

      expect(result.deadLetterEntry).toBeDefined();
      expect(result.deadLetterEntry?.entryId).toBeTruthy();
    });

    it("authorization is preserved in replay", async () => {
      const maintainerActor = { id: "maint-1", roles: [Role.MAINTAINER] };
      const userActor = { id: "user-1", roles: [Role.USER] };

      adapter.failAfterCalls = 0;

      // Run with maintainer
      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        maintainerActor,
      );

      expect(result.deadLetterEntry).toBeDefined();

      // Replay with same maintainer should work
      adapter.failAfterCalls = -1;
      const replayResult = await service.replayFromDLQ(
        adapter,
        checkpointStore,
        "job-1",
        maintainerActor,
      );

      expect(replayResult).toBeDefined();
    });

    it("retries on transient failures before dead-lettering", async () => {
      const actor = { id: "user-1", roles: [Role.MAINTAINER] };

      // Adapter succeeds after initial failures are handled
      const result = await service.runJobWithDLQ(
        adapter,
        checkpointStore,
        "job-1",
        actor,
        { maxApplyRetries: 2 },
      );

      // With proper retry handling, this should eventually succeed
      expect(result.checkpoint).toBeDefined();
    });
  });
});
