import {
  parseRepairArgs,
  resolveCheckpointId,
  formatRepairReport,
  DEFAULT_REPAIR_CHECKPOINT_DIR,
} from "./repair-cli";
import { RepairCheckpoint, RepairJob, RepairAdapter, RepairCheckpointStore } from "./repair-job";
import { Role } from "../guard/roles.enum";
import { ForbiddenException } from "../errors/app.exception";

describe("Repair CLI Tooling with Checkpoints", () => {
  describe("parseRepairArgs", () => {
    it("normal path: parses defaults and dryRun is true by default", () => {
      const args = parseRepairArgs(["--job", "demo-repair"]);
      expect(args.job).toBe("demo-repair");
      expect(args.dryRun).toBe(true);
      expect(args.apply).toBe(false);
      expect(args.batchSize).toBe(100);
      expect(args.maxRepairRetries).toBe(2);
      expect(args.checkpointDir).toBe(DEFAULT_REPAIR_CHECKPOINT_DIR);
    });

    it("normal path: parses --apply flag turning dryRun to false", () => {
      const args = parseRepairArgs(["--job", "demo-repair", "--apply"]);
      expect(args.apply).toBe(true);
      expect(args.dryRun).toBe(false);
    });

    it("normal path: parses custom batch size and checkpoint directory", () => {
      const args = parseRepairArgs([
        "--job",
        "demo-repair",
        "--batch-size",
        "50",
        "--max-retries",
        "5",
        "--checkpoint-dir",
        ".custom-repair",
      ]);
      expect(args.batchSize).toBe(50);
      expect(args.maxRepairRetries).toBe(5);
      expect(args.checkpointDir).toBe(".custom-repair");
    });

    it("resolves checkpoint id correctly", () => {
      expect(resolveCheckpointId(parseRepairArgs(["--job", "job-a"]))).toBe("job-a");
      expect(
        resolveCheckpointId(parseRepairArgs(["--job", "job-a", "--id", "custom-run-1"])),
      ).toBe("custom-run-1");
    });

    it("failure path: throws when --job is missing without --list or --help", () => {
      expect(() => parseRepairArgs([])).toThrow("--job is required");
    });

    it("failure path: throws when invalid positive integer given for batch-size", () => {
      expect(() => parseRepairArgs(["--job", "demo", "--batch-size", "0"])).toThrow(
        "must be a positive integer",
      );
      expect(() => parseRepairArgs(["--job", "demo", "--batch-size", "invalid"])).toThrow(
        "must be a positive integer",
      );
    });

    it("failure path: throws when mutually exclusive flags are combined", () => {
      expect(() =>
        parseRepairArgs(["--job", "demo", "--report", "--rollback"]),
      ).toThrow("mutually exclusive");
      expect(() => parseRepairArgs(["--list", "--report"])).toThrow(
        "mutually exclusive",
      );
      expect(() =>
        parseRepairArgs(["--job", "demo", "--apply", "--rollback"]),
      ).toThrow("--apply cannot be combined with --report, --rollback or --list");
      expect(() =>
        parseRepairArgs(["--job", "demo", "--force"]),
      ).toThrow("--force only applies to --restart");
    });
  });

  describe("formatRepairReport", () => {
    it("normal path: formats dry-run preview report", () => {
      const checkpoint: RepairCheckpoint = {
        jobId: "demo-repair",
        status: "completed",
        dryRun: true,
        cursor: null,
        scanned: 150,
        detected: 12,
        repaired: 0,
        failures: [],
        journal: [],
      };

      const report = formatRepairReport(checkpoint);
      expect(report).toContain("DRY-RUN PREVIEW");
      expect(report).toContain("scanned        150");
      expect(report).toContain("detected       12");
      expect(report).toContain("repaired       0");
    });

    it("normal path: formats applied report with failures", () => {
      const checkpoint: RepairCheckpoint = {
        jobId: "demo-repair",
        status: "completed",
        dryRun: false,
        cursor: null,
        scanned: 150,
        detected: 12,
        repaired: 11,
        failures: [{ recordId: "rec-99", error: "Lock timeout" }],
        journal: [{ recordId: "rec-1", before: {} }],
      };

      const report = formatRepairReport(checkpoint);
      expect(report).toContain("APPLIED");
      expect(report).toContain("repaired       11");
      expect(report).toContain("failures       1");
      expect(report).toContain("rec-99: Lock timeout");
    });
  });

  describe("CLI Execution & Authorization", () => {
    let mockAdapter: jest.Mocked<RepairAdapter<any>>;
    let mockStore: jest.Mocked<RepairCheckpointStore>;

    beforeEach(() => {
      mockAdapter = {
        scan: jest.fn().mockResolvedValue({ records: [], nextCursor: null }),
        detect: jest.fn().mockReturnValue(null),
        repair: jest.fn().mockResolvedValue({}),
        restore: jest.fn().mockResolvedValue(undefined),
      };
      mockStore = {
        load: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      };
    });

    it("authorization path: rejects unauthorized caller (lacks SYSTEM_MAINTENANCE)", async () => {
      const job = new RepairJob(mockAdapter, mockStore);
      const unprivilegedActor = { id: "user-1", roles: [Role.USER] };

      await expect(
        job.run(unprivilegedActor, "job-auth-fail", { dryRun: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        job.rollback(unprivilegedActor, "job-auth-fail"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("retry path: resumes execution from existing checkpoint cursor", async () => {
      const storedCheckpoint: RepairCheckpoint = {
        jobId: "resumable-job",
        status: "failed",
        dryRun: false,
        cursor: "page-2",
        scanned: 50,
        detected: 5,
        repaired: 5,
        failures: [],
        journal: [{ recordId: "rec-1", before: {} }],
      };
      mockStore.load.mockResolvedValueOnce(storedCheckpoint);
      mockAdapter.scan.mockResolvedValueOnce({
        records: [{ id: "rec-60" }],
        nextCursor: null,
      });

      const job = new RepairJob(mockAdapter, mockStore);
      const maintainer = { id: "admin-1", roles: [Role.MAINTAINER] };

      const result = await job.run(maintainer, "resumable-job", { dryRun: false });

      expect(mockAdapter.scan).toHaveBeenCalledWith("page-2", 100);
      expect(result.status).toBe("completed");
    });
  });
});
