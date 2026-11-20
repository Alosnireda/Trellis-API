import { CacheReconciliationService } from "./cache-reconciliation.service";
import { ReconciliationService } from "./reconciliation.service";
import { CacheService } from "../common/cache/cache.service";

describe("CacheReconciliationService", () => {
  let service: CacheReconciliationService;
  let mockReconciliationService: Partial<ReconciliationService>;
  let mockCacheService: Partial<CacheService>;

  beforeEach(() => {
    mockCacheService = {
      has: jest.fn(),
      del: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      keys: jest.fn(),
    };

    mockReconciliationService = {
      getTransaction: jest.fn(),
      getReconciliationSummary: jest.fn(),
    };

    service = new CacheReconciliationService(
      mockReconciliationService as ReconciliationService,
      mockCacheService as CacheService,
    );
  });

  describe("reconcileWithCacheSync", () => {
    it("invalidates transaction cache on reconciliation", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        invoiceId: null,
        destinationAccount: "GACCOUNT",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.has as jest.Mock).mockResolvedValue(true);
      (mockCacheService.del as jest.Mock).mockResolvedValue(undefined);

      const result = await service.reconcileWithCacheSync(txnId);

      expect(result.changed).toBe(true);
      expect(mockCacheService.del).toHaveBeenCalled();
      expect(result.cacheInvalidated.length).toBeGreaterThan(0);
    });

    it("invalidates invoice cache when transaction has invoice", async () => {
      const txnId = "txn-123";
      const invoiceId = "inv-456";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        invoiceId,
        destinationAccount: "GACCOUNT",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.has as jest.Mock).mockResolvedValue(true);
      (mockCacheService.del as jest.Mock).mockResolvedValue(undefined);

      const result = await service.reconcileWithCacheSync(txnId);

      expect(mockCacheService.del).toHaveBeenCalled();
      // Should invalidate both transaction and invoice caches
      const deleteCalls = (mockCacheService.del as jest.Mock).mock.calls;
      const keysDeleted = deleteCalls.map((call) => call[0]);
      expect(keysDeleted.some((key) => key.includes("invoice"))).toBe(true);
    });

    it("invalidates account cache when transaction has account", async () => {
      const txnId = "txn-123";
      const account = "GACCOUNT123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        invoiceId: null,
        destinationAccount: account,
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.has as jest.Mock).mockResolvedValue(true);
      (mockCacheService.del as jest.Mock).mockResolvedValue(undefined);

      const result = await service.reconcileWithCacheSync(txnId);

      expect(mockCacheService.del).toHaveBeenCalled();
      const deleteCalls = (mockCacheService.del as jest.Mock).mock.calls;
      const keysDeleted = deleteCalls.map((call) => call[0]);
      expect(keysDeleted.some((key) => key.includes("account"))).toBe(true);
    });

    it("returns unchanged when no cache entries exist", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        invoiceId: null,
        destinationAccount: null,
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.has as jest.Mock).mockResolvedValue(false);

      const result = await service.reconcileWithCacheSync(txnId);

      expect(result.changed).toBe(false);
      expect(result.cacheInvalidated.length).toBe(0);
    });
  });

  describe("detectCacheDrift", () => {
    it("detects drift when cached state differs from source", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        amount: "100.0000000",
        invoiceId: "inv-456",
        memo: "payment",
      };

      const cachedTxn = {
        transactionId: txnId,
        status: "PENDING",
        amount: "100.0000000",
        invoiceId: "inv-456",
        memo: "payment",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(cachedTxn),
      );
      (mockCacheService.get as jest.Mock).mockResolvedValueOnce(undefined);

      const result = await service.detectCacheDrift(txnId);

      expect(result.hasDrift).toBe(true);
      expect(result.driftDetails).toBeDefined();
      expect(result.driftDetails?.some((d) => d.field === "status")).toBe(true);
    });

    it("returns no drift when cached state matches source", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        amount: "100.0000000",
        invoiceId: "inv-456",
        memo: "payment",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.get as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(mockTransaction),
      );
      (mockCacheService.get as jest.Mock).mockResolvedValueOnce(
        new Date().toISOString(),
      );

      const result = await service.detectCacheDrift(txnId);

      expect(result.hasDrift).toBe(false);
      expect(result.driftDetails).toBeUndefined();
    });

    it("detects drift when cache is empty but transaction exists", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        amount: "100.0000000",
        invoiceId: "inv-456",
        memo: "payment",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.get as jest.Mock).mockResolvedValue(null);

      const result = await service.detectCacheDrift(txnId);

      expect(result.hasDrift).toBe(true);
      expect(result.lastSyncTime).toBeUndefined();
    });
  });

  describe("warmCacheFromSource", () => {
    it("populates cache with source transaction data", async () => {
      const txnId = "txn-123";
      const mockTransaction = {
        transactionId: txnId,
        status: "RECONCILED",
        amount: "100.0000000",
      };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.set as jest.Mock).mockResolvedValue(undefined);

      await service.warmCacheFromSource(txnId);

      expect(mockCacheService.set).toHaveBeenCalled();
      const setCalls = (mockCacheService.set as jest.Mock).mock.calls;
      expect(setCalls.length).toBeGreaterThan(0);
    });

    it("caches audit trail when available", async () => {
      const txnId = "txn-123";
      const mockTransaction = { transactionId: txnId, status: "RECONCILED" };
      const mockAudits = [
        { decision: "RECONCILED", createdAt: new Date() },
        { decision: "PENDING", createdAt: new Date() },
      ];

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: mockAudits,
      });

      (mockCacheService.set as jest.Mock).mockResolvedValue(undefined);

      await service.warmCacheFromSource(txnId, 7200);

      expect(mockCacheService.set).toHaveBeenCalled();
      const setCalls = (mockCacheService.set as jest.Mock).mock.calls;
      // Should have set transaction + sync time + audits
      expect(setCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("respects custom TTL when warming cache", async () => {
      const txnId = "txn-123";
      const customTTL = 7200;
      const mockTransaction = { transactionId: txnId };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.set as jest.Mock).mockResolvedValue(undefined);

      await service.warmCacheFromSource(txnId, customTTL);

      const setCalls = (mockCacheService.set as jest.Mock).mock.calls;
      // Last parameter should be TTL
      expect(setCalls[0][2]).toBe(customTTL);
    });
  });

  describe("invalidateAllCaches", () => {
    it("deletes all reconciliation cache keys", async () => {
      const cacheKeys = [
        "reconcil:txn:123",
        "reconcil:invoice:456",
        "reconcil:account:789",
      ];

      (mockCacheService.keys as jest.Mock).mockResolvedValue(cacheKeys);
      (mockCacheService.del as jest.Mock).mockResolvedValue(undefined);

      const count = await service.invalidateAllCaches();

      expect(count).toBe(3);
      expect(mockCacheService.del).toHaveBeenCalledTimes(3);
    });

    it("returns zero when no cache keys exist", async () => {
      (mockCacheService.keys as jest.Mock).mockResolvedValue([]);

      const count = await service.invalidateAllCaches();

      expect(count).toBe(0);
      expect(mockCacheService.del).not.toHaveBeenCalled();
    });
  });

  describe("getReconciliationSummaryWithCacheMetrics", () => {
    it("returns summary with cache metrics", async () => {
      const mockSummary = {
        totalTransactions: 100,
        reconciled: 85,
        unmatched: 10,
        failed: 5,
      };

      (mockReconciliationService.getReconciliationSummary as jest.Mock)
        .mockResolvedValue(mockSummary);
      (mockCacheService.get as jest.Mock).mockResolvedValue("15");

      const result = await service.getReconciliationSummaryWithCacheMetrics();

      expect(result).toMatchObject(mockSummary);
      expect(result.cacheInvalidatedCount).toBe(15);
      expect(result.cacheHitEstimate).toBe(85);
    });

    it("returns default cache metrics when none stored", async () => {
      const mockSummary = {
        totalTransactions: 100,
        reconciled: 85,
        unmatched: 10,
        failed: 5,
      };

      (mockReconciliationService.getReconciliationSummary as jest.Mock)
        .mockResolvedValue(mockSummary);
      (mockCacheService.get as jest.Mock).mockResolvedValue(null);

      const result = await service.getReconciliationSummaryWithCacheMetrics();

      expect(result.cacheInvalidatedCount).toBe(0);
      expect(result.cacheHitEstimate).toBe(100);
    });
  });

  describe("failure scenarios", () => {
    it("handles missing transaction gracefully", async () => {
      (mockReconciliationService.getTransaction as jest.Mock).mockRejectedValue(
        new Error("Not found"),
      );

      await expect(
        service.reconcileWithCacheSync("nonexistent"),
      ).rejects.toThrow();
    });

    it("handles cache service errors gracefully", async () => {
      const txnId = "txn-123";
      const mockTransaction = { transactionId: txnId };

      (mockReconciliationService.getTransaction as jest.Mock).mockResolvedValue({
        transaction: mockTransaction,
        audits: [],
      });

      (mockCacheService.has as jest.Mock).mockRejectedValue(
        new Error("Cache unavailable"),
      );

      await expect(
        service.reconcileWithCacheSync(txnId),
      ).rejects.toThrow();
    });
  });
});
