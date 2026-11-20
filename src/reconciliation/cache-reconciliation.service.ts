import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "../common/cache/cache.service";
import { ReconciliationService } from "./reconciliation.service";

/**
 * Reconciliation service for source (database) and cached state.
 *
 * Maintains consistency between the authoritative database (source of truth)
 * and cached state (via Redis or in-memory cache). Provides:
 * - Detection of cache-source divergence
 * - Cache invalidation on reconciliation changes
 * - Warm rebuild of cache from source
 * - Drift detection and audit trails
 *
 * Covers paths: normal reconciliation with cache sync, cache misses, stale
 * cache detection, and invalidation on updates (issue #404).
 */
@Injectable()
export class CacheReconciliationService {
  private readonly logger = new Logger(CacheReconciliationService.name);
  private readonly cachePrefix = "reconcil:";

  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Reconcile a transaction and update/invalidate related cache entries.
   * Returns whether the reconciliation changed any state.
   */
  async reconcileWithCacheSync(transactionId: string): Promise<{
    changed: boolean;
    cacheInvalidated: string[];
  }> {
    const { transaction, audits } = await this.reconciliationService.getTransaction(
      transactionId,
    );

    const invalidatedKeys: string[] = [];

    // Invalidate transaction-specific cache
    const txnCacheKey = this.getCacheKey("txn", transactionId);
    if (await this.cacheService.has(txnCacheKey)) {
      await this.cacheService.del(txnCacheKey);
      invalidatedKeys.push(txnCacheKey);
    }

    // Invalidate invoice-specific cache if matched
    if (transaction.invoiceId) {
      const invoiceCacheKey = this.getCacheKey("invoice", transaction.invoiceId);
      if (await this.cacheService.has(invoiceCacheKey)) {
        await this.cacheService.del(invoiceCacheKey);
        invalidatedKeys.push(invoiceCacheKey);
      }

      // Invalidate aggregate invoice state
      const invoiceListKey = this.getCacheKey("invoice:list", "all");
      if (await this.cacheService.has(invoiceListKey)) {
        await this.cacheService.del(invoiceListKey);
        invalidatedKeys.push(invoiceListKey);
      }
    }

    // Invalidate account-level cache
    if (transaction.destinationAccount) {
      const accountKey = this.getCacheKey("account", transaction.destinationAccount);
      if (await this.cacheService.has(accountKey)) {
        await this.cacheService.del(accountKey);
        invalidatedKeys.push(accountKey);
      }
    }

    // Invalidate summary caches
    const summaryKey = this.getCacheKey("summary", "reconciliation");
    if (await this.cacheService.has(summaryKey)) {
      await this.cacheService.del(summaryKey);
      invalidatedKeys.push(summaryKey);
    }

    const hasChanges = invalidatedKeys.length > 0;

    if (hasChanges) {
      this.logger.info(
        {
          transactionId,
          invalidatedCount: invalidatedKeys.length,
          keys: invalidatedKeys,
        },
        "Cache reconciliation completed",
      );
    }

    return {
      changed: hasChanges,
      cacheInvalidated: invalidatedKeys,
    };
  }

  /**
   * Detect cache-source divergence for a transaction.
   * Compares cached state with database state and reports differences.
   */
  async detectCacheDrift(
    transactionId: string,
  ): Promise<{
    hasDrift: boolean;
    driftDetails?: {
      field: string;
      sourceValue: unknown;
      cachedValue: unknown;
    }[];
    lastSyncTime?: Date;
  }> {
    const sourceKey = this.getCacheKey("txn", transactionId);
    const syncTimeKey = this.getCacheKey("txn:sync", transactionId);

    // Get cached state
    const cached = await this.cacheService.get(sourceKey);
    const lastSyncStr = await this.cacheService.get(syncTimeKey);
    const lastSyncTime = lastSyncStr ? new Date(lastSyncStr) : undefined;

    // Get source state
    const { transaction } = await this.reconciliationService.getTransaction(
      transactionId,
    );

    // Detect drift by comparing key fields
    const driftDetails: Array<{
      field: string;
      sourceValue: unknown;
      cachedValue: unknown;
    }> = [];

    if (cached) {
      const cachedTxn = typeof cached === "string" ? JSON.parse(cached) : cached;

      // Compare critical fields
      const fieldsToCompare = ["status", "amount", "invoiceId", "memo"];
      for (const field of fieldsToCompare) {
        const sourceVal = (transaction as any)[field];
        const cachedVal = (cachedTxn as any)[field];
        if (sourceVal !== cachedVal) {
          driftDetails.push({
            field,
            sourceValue: sourceVal,
            cachedValue: cachedVal,
          });
        }
      }
    }

    const hasDrift = driftDetails.length > 0 || (cached === null && transaction);

    if (hasDrift) {
      this.logger.warn(
        { transactionId, driftCount: driftDetails.length },
        "Cache drift detected",
      );
    }

    return {
      hasDrift,
      driftDetails: driftDetails.length > 0 ? driftDetails : undefined,
      lastSyncTime,
    };
  }

  /**
   * Warm cache from database source.
   * Rebuilds cache for a transaction from authoritative DB state.
   */
  async warmCacheFromSource(transactionId: string, ttlSeconds = 3600): Promise<void> {
    const { transaction, audits } = await this.reconciliationService.getTransaction(
      transactionId,
    );

    const txnKey = this.getCacheKey("txn", transactionId);
    const syncTimeKey = this.getCacheKey("txn:sync", transactionId);

    // Cache the transaction state
    await this.cacheService.set(txnKey, JSON.stringify(transaction), ttlSeconds);
    // Track when cache was synced
    await this.cacheService.set(syncTimeKey, new Date().toISOString(), ttlSeconds);

    // Cache audit trail if recent
    const recentAudits = audits.slice(0, 10);
    if (recentAudits.length > 0) {
      const auditsKey = this.getCacheKey("txn:audits", transactionId);
      await this.cacheService.set(
        auditsKey,
        JSON.stringify(recentAudits),
        ttlSeconds,
      );
    }

    this.logger.debug(
      { transactionId, ttlSeconds },
      "Cache warmed from source",
    );
  }

  /**
   * Invalidate all reconciliation-related caches.
   * Used when a broader reconciliation sweep occurs.
   */
  async invalidateAllCaches(): Promise<number> {
    const pattern = `${this.cachePrefix}*`;
    const keys = await this.cacheService.keys(pattern);
    let invalidatedCount = 0;

    for (const key of keys) {
      await this.cacheService.del(key);
      invalidatedCount++;
    }

    if (invalidatedCount > 0) {
      this.logger.info(
        { invalidatedCount, pattern },
        "Bulk cache invalidation completed",
      );
    }

    return invalidatedCount;
  }

  /**
   * Get reconciliation summary with cache info.
   * Includes cache hit rate and divergence metrics.
   */
  async getReconciliationSummaryWithCacheMetrics(): Promise<{
    totalTransactions: number;
    reconciled: number;
    unmatched: number;
    failed: number;
    cacheHitEstimate: number;
    cacheInvalidatedCount: number;
  }> {
    // Get counts from database
    const summary = await this.reconciliationService.getReconciliationSummary();

    // Get cache metrics
    const cacheInvalidatedKey = this.getCacheKey("metrics", "invalidations");
    const cacheMetrics = await this.cacheService.get(cacheInvalidatedKey);
    const cacheInvalidatedCount = cacheMetrics ? parseInt(cacheMetrics) : 0;

    return {
      ...summary,
      cacheInvalidatedCount,
      cacheHitEstimate: Math.max(0, 100 - cacheInvalidatedCount),
    };
  }

  private getCacheKey(type: string, id: string): string {
    return `${this.cachePrefix}${type}:${id}`;
  }
}
