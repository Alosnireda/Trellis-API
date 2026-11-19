import { ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { SyntheticJourneyMonitorService } from "./synthetic-journey.service";
jest.mock("../../common/decorators/skip-kyc.decorator", () => ({
  SkipKyc: () => () => undefined,
}));

import { SyntheticJourneyController } from "./synthetic-journey.controller";
import { MonitoringMetricsService } from "../monitoring-metrics.service";
import { SyntheticJourneyStepDefinition } from "./synthetic-journey.types";

describe("SyntheticJourneyMonitorService", () => {
  let service: SyntheticJourneyMonitorService;
  let mockMetricsService: Partial<MonitoringMetricsService>;

  beforeEach(async () => {
    mockMetricsService = {
      incrementCounter: jest.fn(),
      gauge: jest.fn().mockReturnValue({ set: jest.fn() }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyntheticJourneyMonitorService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === "NODE_ENV") return "test";
              return undefined;
            }),
          },
        },
        {
          provide: MonitoringMetricsService,
          useValue: mockMetricsService,
        },
      ],
    }).compile();

    service = module.get<SyntheticJourneyMonitorService>(SyntheticJourneyMonitorService);
  });

  afterEach(() => {
    service.stopScheduler();
    jest.clearAllMocks();
  });

  describe("Happy Path Execution", () => {
    it("should execute all steps successfully and return overall status SUCCESS", async () => {
      const report = await service.runJourney({ trigger: "MANUAL" });

      expect(report).toBeDefined();
      expect(report.status).toBe("SUCCESS");
      expect(report.totalSteps).toBe(5);
      expect(report.passedSteps).toBe(5);
      expect(report.failedSteps).toBe(0);
      expect(report.degradedSteps).toBe(0);
      expect(report.dependencyBlame).toHaveLength(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);

      const stepIds = report.steps.map((s) => s.stepId);
      expect(stepIds).toEqual([
        "step_auth_verify",
        "step_portfolio_rebalance",
        "step_defi_yield",
        "step_settlement_reconcile",
        "step_notification_dispatch",
      ]);

      expect(mockMetricsService.incrementCounter).toHaveBeenCalled();
      expect(mockMetricsService.gauge).toHaveBeenCalled();
    });
  });

  describe("Failure Detection and Dependency Blame Attribution", () => {
    it("should attribute blame to POSTGRES_DB when database step fails", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        simulateFailureStep: "step_portfolio_rebalance",
      });

      expect(report.status).toBe("FAILED");
      expect(report.failedSteps).toBe(1);
      expect(report.dependencyBlame).toContain("POSTGRES_DB");

      const failedStep = report.steps.find((s) => s.stepId === "step_portfolio_rebalance");
      expect(failedStep?.status).toBe("FAILED");
      expect(failedStep?.error?.blame).toBe("POSTGRES_DB");
      expect(failedStep?.error?.remediation).toMatch(/PostgreSQL/);

      // Subsequent steps should be SKIPPED
      const subsequentSteps = report.steps.slice(2);
      for (const step of subsequentSteps) {
        expect(step.status).toBe("SKIPPED");
      }
    });

    it("should attribute blame to STELLAR_HORIZON when reconciliation step times out", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        simulateFailureStep: "step_settlement_reconcile",
      });

      expect(report.status).toBe("FAILED");
      expect(report.failedSteps).toBe(1);
      expect(report.dependencyBlame).toContain("STELLAR_HORIZON");

      const failedStep = report.steps.find((s) => s.stepId === "step_settlement_reconcile");
      expect(failedStep?.error?.blame).toBe("STELLAR_HORIZON");
      expect(failedStep?.error?.remediation).toMatch(/Horizon/);
    });

    it("should attribute blame to DEFI_PROTOCOL_RPC when DeFi call fails", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        simulateFailureStep: "step_defi_yield",
      });

      expect(report.status).toBe("FAILED");
      expect(report.dependencyBlame).toContain("DEFI_PROTOCOL_RPC");
    });

    it("should attribute blame to NOTIFICATION_GATEWAY when notification dispatch fails", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        simulateFailureStep: "step_notification_dispatch",
      });

      expect(report.status).toBe("FAILED");
      expect(report.dependencyBlame).toContain("NOTIFICATION_GATEWAY");
    });
  });

  describe("Latency Degradation & SLA Violation Tracking", () => {
    it("should flag step as DEGRADED when SLA threshold is exceeded", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        simulateLatencyStep: { stepId: "step_auth_verify", extraMs: 350 }, // SLA is 300ms
      });

      expect(report.status).toBe("DEGRADED");
      expect(report.degradedSteps).toBe(1);
      expect(report.passedSteps).toBe(4);
      expect(report.failedSteps).toBe(0);

      const authStep = report.steps.find((s) => s.stepId === "step_auth_verify");
      expect(authStep?.status).toBe("DEGRADED");
      expect(authStep?.slaBreached).toBe(true);
      expect(authStep?.latencyMs).toBeGreaterThanOrEqual(300);
    });
  });

  describe("Scheduled Runner", () => {
    it("should manage scheduler start and stop cleanly", () => {
      expect(() => {
        service.startScheduler(5000);
        service.stopScheduler();
      }).not.toThrow();
    });
  });

  describe("Transient Retry & Fault-Injection Authorization", () => {
    it("should recover on retry when transient failures are within maxStepRetries", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        maxStepRetries: 2,
        simulateTransientFailureStep: {
          stepId: "step_defi_yield",
          failAttempts: 2,
        },
      });

      expect(report.status).toBe("SUCCESS");
      const defiStep = report.steps.find((s) => s.stepId === "step_defi_yield");
      expect(defiStep?.status).toBe("PASSED");
      expect(defiStep?.attempts).toBe(3);
      expect(defiStep?.metadata?.recoveredAfterRetries).toBe(2);
    });

    it("should fail and attribute blame when transient failures exceed maxStepRetries", async () => {
      const report = await service.runJourney({
        trigger: "MANUAL",
        maxStepRetries: 1,
        simulateTransientFailureStep: {
          stepId: "step_settlement_reconcile",
          failAttempts: 3,
        },
      });

      expect(report.status).toBe("FAILED");
      expect(report.dependencyBlame).toContain("STELLAR_HORIZON");
      const reconcileStep = report.steps.find((s) => s.stepId === "step_settlement_reconcile");
      expect(reconcileStep?.status).toBe("FAILED");
      expect(reconcileStep?.attempts).toBe(2);
    });

    it("should enforce authorization for fault injection when SYNTHETIC_FAULT_INJECTION_TOKEN is set", async () => {
      const controller = new SyntheticJourneyController(service);
      const mockRes = { status: jest.fn() } as any;
      const prevToken = process.env.SYNTHETIC_FAULT_INJECTION_TOKEN;
      process.env.SYNTHETIC_FAULT_INJECTION_TOKEN = "super-secret-admin-token";

      try {
        await expect(
          controller.runJourney(mockRes, "step_auth_verify", undefined, undefined),
        ).rejects.toThrow(ForbiddenException);

        await expect(
          controller.runJourney(mockRes, "step_auth_verify", undefined, "wrong-token"),
        ).rejects.toThrow(ForbiddenException);

        const report = await controller.runJourney(
          mockRes,
          "step_auth_verify",
          "0",
          "super-secret-admin-token",
        );
        expect(report.status).toBe("FAILED");
        expect(mockRes.status).toHaveBeenCalledWith(503);
      } finally {
        if (prevToken === undefined) {
          delete process.env.SYNTHETIC_FAULT_INJECTION_TOKEN;
        } else {
          process.env.SYNTHETIC_FAULT_INJECTION_TOKEN = prevToken;
        }
      }
    });
  });
});
