import { DataSource } from "typeorm";
import {
  evaluateMigrationCompatibility,
  readAppliedMigrations,
  MigrationHistoryUnavailableError,
} from "./storage-schema-compatibility";
import {
  FIXTURE_KNOWN_MIGRATIONS,
  FIXTURE_MIGRATION_NOTES,
  VALID_SEQUENTIAL_CHAIN_FIXTURE,
  UPGRADE_READY_WITH_NOTES_FIXTURE,
  CORRUPTED_OUT_OF_ORDER_FIXTURE,
  FUTURE_UNKNOWN_VERSION_FIXTURE,
  DUPLICATE_APPLIED_TIMESTAMP_FIXTURE,
} from "./fixtures/migration-compatibility-fixtures";
import { Role, hasRole } from "../common/guard/roles.enum";
import { VERSIONED_MIGRATION_NOTES } from "./migration-notes.types";
import { ROLES_KEY } from "../common/guard/roles.decorator";
import { AppController } from "../app.controller";

function dataSourceWithQuery(query: jest.Mock): DataSource {
  return {
    options: {},
    query,
  } as unknown as DataSource;
}

describe("Versioned Migration Notes and Compatibility Fixtures (#424)", () => {
  describe("Normal Path with Fixtures", () => {
    it("reports up-to-date for valid sequential applied history fixture", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        VALID_SEQUENTIAL_CHAIN_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      expect(report.status).toBe(VALID_SEQUENTIAL_CHAIN_FIXTURE.expectedStatus);
      expect(report.compatible).toBe(true);
      expect(report.currentVersion).toBe(
        "1715000000000-AddBoundedQueueIndexes",
      );
      expect(report.nextVersion).toBeNull();
      expect(report.pendingVersions).toEqual([]);
      expect(report.hasBreakingPending).toBe(false);
      expect(report.irreversiblePendingVersions).toEqual([]);
    });

    it("reports upgrade-ready and populates versioned migration notes and breaking alerts", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        UPGRADE_READY_WITH_NOTES_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      expect(report.status).toBe(UPGRADE_READY_WITH_NOTES_FIXTURE.expectedStatus);
      expect(report.compatible).toBe(true);
      expect(report.currentVersion).toBe(
        "1705000000000-AddSensitiveActionHashChains",
      );
      expect(report.nextVersion).toBe(
        "1710000000000-StellarReconciliationPartitioning",
      );
      expect(report.pendingVersions).toEqual(
        UPGRADE_READY_WITH_NOTES_FIXTURE.expectedPending,
      );

      // Verify versioned migration notes attached
      expect(report.migrationNotes).toBeDefined();
      const partitionNote =
        report.migrationNotes![
          "1710000000000-StellarReconciliationPartitioning"
        ];
      expect(partitionNote).toBeDefined();
      expect(partitionNote.impact).toBe("breaking");
      expect(partitionNote.reversible).toBe(false);
      expect(partitionNote.breakingChanges).toHaveLength(1);
      expect(partitionNote.manualSteps).toContain(
        "Stop Horizon polling worker: POST /pause-control/activate { scope: 'horizon_ingestion' }.",
      );

      // Verify breaking and irreversible flags surfaced
      expect(report.hasBreakingPending).toBe(true);
      expect(report.irreversiblePendingVersions).toEqual([
        "1710000000000-StellarReconciliationPartitioning",
      ]);
    });
  });

  describe("Failure Paths with Adversarial Fixtures", () => {
    it("fails closed (incompatible) on corrupted out-of-order migration chain fixture", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        CORRUPTED_OUT_OF_ORDER_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      expect(report.status).toBe(CORRUPTED_OUT_OF_ORDER_FIXTURE.expectedStatus);
      expect(report.compatible).toBe(false);
      expect(report.reason).toMatch(/Migration history diverges/);
    });

    it("fails closed (incompatible) when database contains future unknown migration", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        FUTURE_UNKNOWN_VERSION_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      expect(report.status).toBe(FUTURE_UNKNOWN_VERSION_FIXTURE.expectedStatus);
      expect(report.compatible).toBe(false);
      expect(report.reason).toMatch(
        /Database migration history is ahead of this application build/,
      );
    });

    it("fails closed (incompatible) on duplicate applied migration timestamps", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        DUPLICATE_APPLIED_TIMESTAMP_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      expect(report.status).toBe(
        DUPLICATE_APPLIED_TIMESTAMP_FIXTURE.expectedStatus,
      );
      expect(report.compatible).toBe(false);
      expect(report.reason).toMatch(/duplicate timestamp/);
    });
  });

  describe("Retry Path", () => {
    it("retries transient database errors up to maxAttempts and throws MigrationHistoryUnavailableError", async () => {
      const query = jest.fn().mockRejectedValue({ code: "40001" }); // serialization failure
      const dataSource = dataSourceWithQuery(query);
      const sleep = jest.fn().mockResolvedValue(undefined);

      await expect(
        readAppliedMigrations(dataSource, 3, sleep),
      ).rejects.toBeInstanceOf(MigrationHistoryUnavailableError);

      expect(query).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("succeeds when transient database error resolves on retry", async () => {
      const query = jest
        .fn()
        .mockRejectedValueOnce({ code: "ECONNRESET" })
        .mockResolvedValueOnce([
          { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
        ]);
      const dataSource = dataSourceWithQuery(query);
      const sleep = jest.fn().mockResolvedValue(undefined);

      const rows = await readAppliedMigrations(dataSource, 3, sleep);

      expect(rows).toEqual([
        { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
      ]);
      expect(query).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });

  describe("Authorization Path", () => {
    it("enforces operator role hierarchy on migration compatibility check", () => {
      const handler = AppController.prototype.getStorageMigrationCompatibility;
      const requiredRoles = Reflect.getMetadata(ROLES_KEY, handler) as Role[];

      expect(requiredRoles).toEqual([Role.OPERATOR]);
      expect(hasRole(Role.USER, Role.OPERATOR)).toBe(false);
      expect(hasRole(Role.OPERATOR, Role.OPERATOR)).toBe(true);
      expect(hasRole(Role.MAINTAINER, Role.OPERATOR)).toBe(true);
      expect(hasRole(Role.ADMIN, Role.OPERATOR)).toBe(true);
    });
  });

  describe("Rollback & Edge Case Guidance", () => {
    it("surfaces detailed rollback instructions and irreversible warnings", () => {
      const report = evaluateMigrationCompatibility(
        FIXTURE_KNOWN_MIGRATIONS,
        UPGRADE_READY_WITH_NOTES_FIXTURE.applied,
        FIXTURE_MIGRATION_NOTES,
      );

      const partitionNote =
        report.migrationNotes![
          "1710000000000-StellarReconciliationPartitioning"
        ];
      expect(partitionNote.rollbackGuidance).toMatch(
        /IRREVERSIBLE AUTOMATICALLY/,
      );
      expect(report.irreversiblePendingVersions).toContain(
        "1710000000000-StellarReconciliationPartitioning",
      );
    });
  });
});

describe("Versioned record schema compatibility (#414)", () => {
  const entries = Object.entries(VERSIONED_MIGRATION_NOTES);

  it("keeps every record's id, version, and embedded timestamp consistent", () => {
    for (const [id, note] of entries) {
      expect(note.version).toBe(id);
      expect(id.startsWith(`${note.timestamp}-`)).toBe(true);
    }
  });

  it("only references prerequisites that exist and precede the record", () => {
    for (const [, note] of entries) {
      for (const prereq of note.prerequisites ?? []) {
        const parent = VERSIONED_MIGRATION_NOTES[prereq];
        expect(parent).toBeDefined();
        expect(parent.timestamp).toBeLessThan(note.timestamp);
      }
    }
  });

  it("documents rollback guidance and manual steps for breaking or irreversible records", () => {
    const risky = entries.filter(
      ([, n]) => !n.reversible || n.impact === "breaking" || n.impact === "security",
    );
    expect(risky.length).toBeGreaterThan(0);
    for (const [, note] of risky) {
      expect((note.rollbackGuidance ?? "").trim()).not.toBe("");
      expect(note.manualSteps?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives every record a non-empty summary and at least one target table", () => {
    for (const [, note] of entries) {
      expect(note.summary.trim()).not.toBe("");
      expect(note.targetTables.length).toBeGreaterThan(0);
    }
  });
});

