import { ForbiddenException } from "@nestjs/common";
import { Permission, Role, hasPermission, hasRole } from "../guard/roles.enum";

export interface BatchActor {
  id: string;
  roles: Role[];
}

export type BatchFailureMode = "fail-fast" | "collect-errors";

export interface BoundedBatchOptions<TItem, TResult> {
  name: string;
  /** Maximum number of items in flight per batch slice (strictly bounds memory footprint) */
  batchSize: number;
  /** Maximum concurrent worker tasks processing items within a slice (defaults to 1) */
  concurrency?: number;
  /** Optional delay in ms between consecutive batch slices to prevent DB/API rate-limit throttling */
  interBatchDelayMs?: number;
  /** Maximum retry attempts per item for transient failures (defaults to 1 = no retry) */
  maxAttempts?: number;
  /** Base retry delay in ms (doubles on each attempt: base * 2^(attempt-1)) */
  retryDelayMs?: number;
  /** Function to distinguish transient/retryable errors from permanent ones */
  isRetryable?: (error: unknown) => boolean;
  /** Failure handling mode: fail-fast (aborts on first failure) or collect-errors (isolates failures) */
  mode?: BatchFailureMode;
  /** Required role for actor authorization */
  requiredRole?: Role;
  /** Required permission for actor authorization */
  requiredPermission?: Permission;
  /** Cooperative cancellation token */
  signal?: AbortSignal;
  /** Custom sleep function for deterministic time advancement in tests */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress callback executed after each slice */
  onProgress?: (progress: BatchProgress) => void | Promise<void>;
}

export interface BatchProgress {
  batchIndex: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  totalItems?: number;
}

export interface BatchItemError<TItem> {
  item: TItem;
  itemIndex: number;
  error: Error;
  attempts: number;
}

export interface BatchProcessingResult<TItem, TResult> {
  name: string;
  totalItems: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  results: TResult[];
  errors: BatchItemError<TItem>[];
  durationMs: number;
  aborted: boolean;
}

/**
 * BoundedBatchProcessor (#423)
 *
 * Implements bounded, memory-capped batch processing for arbitrarily large datasets.
 * Guarantees O(batchSize) auxiliary space complexity regardless of total dataset size.
 */
export class BoundedBatchProcessor<TItem, TResult = unknown> {
  private readonly name: string;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly interBatchDelayMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly mode: BatchFailureMode;
  private readonly requiredRole?: Role;
  private readonly requiredPermission?: Permission;
  private readonly signal?: AbortSignal;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onProgress?: (progress: BatchProgress) => void | Promise<void>;

  constructor(options: BoundedBatchOptions<TItem, TResult>) {
    if (options.batchSize <= 0) {
      throw new RangeError("batchSize must be greater than 0");
    }
    this.name = options.name;
    this.batchSize = Math.max(1, Math.floor(options.batchSize));
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.interBatchDelayMs = Math.max(0, options.interBatchDelayMs ?? 0);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 50);
    this.isRetryable = options.isRetryable ?? (() => true);
    this.mode = options.mode ?? "fail-fast";
    this.requiredRole = options.requiredRole;
    this.requiredPermission = options.requiredPermission;
    this.signal = options.signal;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onProgress = options.onProgress;
  }

  /**
   * Process an iterable or stream of items with bounded memory and concurrency.
   *
   * @param actor The caller requesting batch execution (authorized before any work begins)
   * @param source Stream, AsyncIterable, Iterable, or Array of items
   * @param worker Worker function processing a single item
   */
  async process(
    actor: BatchActor,
    source: Iterable<TItem> | AsyncIterable<TItem>,
    worker: (item: TItem, index: number) => Promise<TResult>,
  ): Promise<BatchProcessingResult<TItem, TResult>> {
    // 1. Authorization Gate
    this.assertAuthorized(actor);

    const startTime = Date.now();
    const results: TResult[] = [];
    const errors: BatchItemError<TItem>[] = [];

    let processedCount = 0;
    let successCount = 0;
    let failureCount = 0;
    let batchIndex = 0;
    let aborted = false;

    // Buffer holds at most `batchSize` items at any time -> O(batchSize) space complexity
    let currentSlice: { item: TItem; globalIndex: number }[] = [];
    let globalIndex = 0;

    const flushSlice = async () => {
      if (currentSlice.length === 0 || aborted) return;

      if (this.signal?.aborted) {
        aborted = true;
        return;
      }

      batchIndex += 1;
      const sliceResults = await this.processSlice(currentSlice, worker);

      for (const res of sliceResults) {
        processedCount += 1;
        if (res.error) {
          failureCount += 1;
          errors.push({
            item: res.item,
            itemIndex: res.globalIndex,
            error: res.error,
            attempts: res.attempts,
          });

          if (this.mode === "fail-fast") {
            aborted = true;
            if (this.onProgress) {
              await this.onProgress({
                batchIndex,
                processedCount,
                successCount,
                failureCount,
              });
            }
            throw res.error;
          }
        } else {
          successCount += 1;
          results.push(res.result!);
        }
      }

      if (this.onProgress) {
        await this.onProgress({
          batchIndex,
          processedCount,
          successCount,
          failureCount,
        });
      }

      currentSlice = [];

      // Inter-batch throttling delay to yield CPU and respect downstream rate limits
      if (this.interBatchDelayMs > 0 && !aborted) {
        await this.sleep(this.interBatchDelayMs);
      }
    };

    // Iterate through source stream/iterator
    for await (const item of source) {
      if (this.signal?.aborted) {
        aborted = true;
        break;
      }

      currentSlice.push({ item, globalIndex });
      globalIndex += 1;

      if (currentSlice.length >= this.batchSize) {
        await flushSlice();
        if (aborted) break;
      }
    }

    // Flush any remaining items in final partial slice
    if (currentSlice.length > 0 && !aborted) {
      await flushSlice();
    }

    return {
      name: this.name,
      totalItems: globalIndex,
      processedCount,
      successCount,
      failureCount,
      results,
      errors,
      durationMs: Date.now() - startTime,
      aborted,
    };
  }

  /**
   * Process a single bounded slice using controlled worker concurrency.
   */
  private async processSlice(
    slice: { item: TItem; globalIndex: number }[],
    worker: (item: TItem, index: number) => Promise<TResult>,
  ): Promise<
    Array<{
      item: TItem;
      globalIndex: number;
      result?: TResult;
      error?: Error;
      attempts: number;
    }>
  > {
    const results: Array<{
      item: TItem;
      globalIndex: number;
      result?: TResult;
      error?: Error;
      attempts: number;
    }> = new Array(slice.length);

    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < slice.length) {
        if (this.signal?.aborted) break;

        const currentIndex = nextIndex;
        nextIndex += 1;
        const entry = slice[currentIndex];

        const itemResult = await this.executeWithRetry(
          entry.item,
          entry.globalIndex,
          worker,
        );
        results[currentIndex] = {
          item: entry.item,
          globalIndex: entry.globalIndex,
          result: itemResult.result,
          error: itemResult.error,
          attempts: itemResult.attempts,
        };

        if (itemResult.error && this.mode === "fail-fast") {
          break;
        }
      }
    };

    // Spawn up to `this.concurrency` workers concurrently
    const activeWorkers = Math.min(this.concurrency, slice.length);
    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < activeWorkers; i++) {
      workerPromises.push(runWorker());
    }

    await Promise.all(workerPromises);
    return results.filter(Boolean);
  }

  /**
   * Execute an individual item with exponential backoff retry.
   */
  private async executeWithRetry(
    item: TItem,
    index: number,
    worker: (item: TItem, index: number) => Promise<TResult>,
  ): Promise<{ result?: TResult; error?: Error; attempts: number }> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.signal?.aborted) {
        return {
          error: new Error("Operation aborted by signal"),
          attempts: attempt,
        };
      }

      try {
        const result = await worker(item, index);
        return { result, attempts: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const canRetry =
          attempt < this.maxAttempts && this.isRetryable(lastError);

        if (canRetry) {
          const delay = this.retryDelayMs * 2 ** (attempt - 1);
          await this.sleep(delay);
        } else {
          break;
        }
      }
    }

    return { error: lastError, attempts: this.maxAttempts };
  }

  private assertAuthorized(actor: BatchActor): void {
    if (this.requiredRole) {
      const authorized = actor.roles.some((role) =>
        hasRole(role, this.requiredRole!),
      );
      if (!authorized) {
        throw new ForbiddenException(
          `Actor ${actor.id} lacks required role ${this.requiredRole} to execute batch ${this.name}`,
        );
      }
    }

    if (this.requiredPermission) {
      const authorized = actor.roles.some((role) =>
        hasPermission(role, this.requiredPermission!),
      );
      if (!authorized) {
        throw new ForbiddenException(
          `Actor ${actor.id} lacks required permission ${this.requiredPermission} to execute batch ${this.name}`,
        );
      }
    }
  }
}

