import { ForbiddenException } from "@nestjs/common";
import {
  BoundedBatchProcessor,
  BatchActor,
} from "./bounded-batch-processor";
import { Role, Permission } from "../guard/roles.enum";

describe("BoundedBatchProcessor (#423)", () => {
  const operatorActor: BatchActor = {
    id: "op-1",
    roles: [Role.OPERATOR],
  };

  const userActor: BatchActor = {
    id: "user-1",
    roles: [Role.USER],
  };

  describe("Normal Path", () => {
    it("processes a large dataset in bounded chunks with controlled concurrency", async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, val: i }));
      const sleepDelays: number[] = [];

      const processor = new BoundedBatchProcessor<{ id: string; val: number }, number>({
        name: "test-bulk-sync",
        batchSize: 20,
        concurrency: 4,
        interBatchDelayMs: 10,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
      });

      const processedIndices: number[] = [];
      const result = await processor.process(operatorActor, items, async (item, index) => {
        processedIndices.push(index);
        return item.val * 2;
      });

      expect(result.totalItems).toBe(100);
      expect(result.processedCount).toBe(100);
      expect(result.successCount).toBe(100);
      expect(result.failureCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.results).toHaveLength(100);
      expect(result.results[0]).toBe(0);
      expect(result.results[99]).toBe(198);
      // 5 batches of 20 -> 4 inter-batch delays of 10ms
      expect(sleepDelays).toEqual([10, 10, 10, 10]);
    });

    it("handles async generator streams without buffering entire dataset in memory", async () => {
      async function* generateItems() {
        for (let i = 0; i < 50; i++) {
          yield { id: i };
        }
      }

      const processor = new BoundedBatchProcessor<{ id: number }, number>({
        name: "stream-processor",
        batchSize: 10,
        concurrency: 2,
      });

      const result = await processor.process(operatorActor, generateItems(), async (item) => {
        return item.id * 10;
      });

      expect(result.totalItems).toBe(50);
      expect(result.processedCount).toBe(50);
      expect(result.results).toHaveLength(50);
    });

    it("emits progress callbacks after each batch slice", async () => {
      const items = Array.from({ length: 30 }, (_, i) => i);
      const progressLog: Array<{ batchIndex: number; processedCount: number }> = [];

      const processor = new BoundedBatchProcessor<number, number>({
        name: "progress-test",
        batchSize: 10,
        onProgress: (p) => {
          progressLog.push({
            batchIndex: p.batchIndex,
            processedCount: p.processedCount,
          });
        },
      });

      await processor.process(operatorActor, items, async (n) => n + 1);

      expect(progressLog).toEqual([
        { batchIndex: 1, processedCount: 10 },
        { batchIndex: 2, processedCount: 20 },
        { batchIndex: 3, processedCount: 30 },
      ]);
    });
  });

  describe("Failure Modes", () => {
    it("fail-fast mode halts immediately on first unrecoverable error and rethrows", async () => {
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const processor = new BoundedBatchProcessor<number, number>({
        name: "fail-fast-test",
        batchSize: 2,
        mode: "fail-fast",
      });

      await expect(
        processor.process(operatorActor, items, async (n) => {
          if (n === 3) throw new Error("Poisoned record at 3");
          return n;
        }),
      ).rejects.toThrow("Poisoned record at 3");
    });

    it("collect-errors mode isolates failures and continues processing remaining items", async () => {
      const items = [1, 2, 3, 4, 5, 6];

      const processor = new BoundedBatchProcessor<number, number>({
        name: "collect-errors-test",
        batchSize: 2,
        mode: "collect-errors",
      });

      const result = await processor.process(operatorActor, items, async (n) => {
        if (n === 2 || n === 5) throw new Error(`Invalid item ${n}`);
        return n * 10;
      });

      expect(result.processedCount).toBe(6);
      expect(result.successCount).toBe(4);
      expect(result.failureCount).toBe(2);
      expect(result.results).toEqual([10, 30, 40, 60]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].item).toBe(2);
      expect(result.errors[0].error.message).toBe("Invalid item 2");
      expect(result.errors[1].item).toBe(5);
      expect(result.errors[1].error.message).toBe("Invalid item 5");
    });
  });

  describe("Retry Path", () => {
    it("retries transient failures with exponential backoff and succeeds", async () => {
      const sleepDelays: number[] = [];
      const attemptsMap = new Map<number, number>();

      const processor = new BoundedBatchProcessor<number, string>({
        name: "retry-test",
        batchSize: 5,
        maxAttempts: 3,
        retryDelayMs: 25,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
        isRetryable: (err) => (err as Error).message.includes("Transient timeout"),
      });

      const items = [100, 200];
      const result = await processor.process(operatorActor, items, async (n) => {
        const count = (attemptsMap.get(n) ?? 0) + 1;
        attemptsMap.set(n, count);

        if (n === 200 && count < 3) {
          throw new Error("Transient timeout from database");
        }
        return `done-${n}`;
      });

      expect(result.successCount).toBe(2);
      expect(attemptsMap.get(100)).toBe(1);
      expect(attemptsMap.get(200)).toBe(3);
      // Item 200 failed at attempt 1 (delay 25) and attempt 2 (delay 50)
      expect(sleepDelays).toEqual([25, 50]);
    });

    it("does not retry permanent non-retryable errors", async () => {
      let attempts = 0;
      const processor = new BoundedBatchProcessor<number, number>({
        name: "permanent-error-test",
        batchSize: 2,
        maxAttempts: 3,
        mode: "collect-errors",
        isRetryable: (err) => (err as Error).message.includes("Network"),
      });

      const result = await processor.process(operatorActor, [1], async () => {
        attempts += 1;
        throw new Error("Schema validation failure (permanent)");
      });

      expect(attempts).toBe(1); // No retries attempted
      expect(result.failureCount).toBe(1);
    });
  });

  describe("Authorization Path", () => {
    it("rejects unauthorized actors before processing any batches", async () => {
      let workerCalled = false;
      const processor = new BoundedBatchProcessor<number, number>({
        name: "admin-batch",
        batchSize: 5,
        requiredRole: Role.OPERATOR,
      });

      await expect(
        processor.process(userActor, [1, 2, 3], async (n) => {
          workerCalled = true;
          return n;
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(workerCalled).toBe(false);
    });

    it("allows actors with required permission to proceed", async () => {
      const processor = new BoundedBatchProcessor<number, number>({
        name: "permission-batch",
        batchSize: 5,
        requiredPermission: Permission.PAYMENT_PROCESS,
      });

      const result = await processor.process(operatorActor, [1, 2], async (n) => n * 2);
      expect(result.successCount).toBe(2);
    });
  });

  describe("Cancellation & Abort Path", () => {
    it("halts processing when AbortSignal is triggered", async () => {
      const abortController = new AbortController();
      const items = Array.from({ length: 50 }, (_, i) => i);

      const processor = new BoundedBatchProcessor<number, number>({
        name: "cancellable-batch",
        batchSize: 5,
        signal: abortController.signal,
        onProgress: (p) => {
          if (p.batchIndex === 2) {
            abortController.abort();
          }
        },
      });

      const result = await processor.process(operatorActor, items, async (n) => n);

      expect(result.aborted).toBe(true);
      expect(result.processedCount).toBe(10); // halted after 2 batches of 5
    });
  });
});

