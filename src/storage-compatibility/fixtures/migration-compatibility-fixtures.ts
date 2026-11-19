import { MigrationVersion, AppliedMigration } from "../storage-schema-compatibility";
import { VersionedMigrationNote } from "../migration-notes.types";

/**
 * Standard checked-in migration versions for testing compatibility chains.
 */
export const FIXTURE_KNOWN_MIGRATIONS: MigrationVersion[] = [
  { timestamp: 1700000000000, id: "1700000000000-InitialCoreSchema" },
  { timestamp: 1705000000000, id: "1705000000000-AddSensitiveActionHashChains" },
  { timestamp: 1710000000000, id: "1710000000000-StellarReconciliationPartitioning" },
  { timestamp: 1715000000000, id: "1715000000000-AddBoundedQueueIndexes" },
];

export const FIXTURE_MIGRATION_NOTES: Record<string, VersionedMigrationNote> = {
  "1700000000000-InitialCoreSchema": {
    version: "1700000000000-InitialCoreSchema",
    timestamp: 1700000000000,
    title: "Initial Core Schema",
    impact: "compatible",
    reversible: true,
    targetTables: ["users", "wallets", "api_keys"],
    summary: "Base tables for identity and authentication.",
  },
  "1705000000000-AddSensitiveActionHashChains": {
    version: "1705000000000-AddSensitiveActionHashChains",
    timestamp: 1705000000000,
    title: "Sensitive Action Hash Chains",
    impact: "security",
    reversible: true,
    targetTables: ["sensitive_action_events"],
    summary: "Cryptographic tamper-evident hash chaining.",
  },
  "1710000000000-StellarReconciliationPartitioning": {
    version: "1710000000000-StellarReconciliationPartitioning",
    timestamp: 1710000000000,
    title: "Stellar Reconciliation Range Partitioning",
    impact: "breaking",
    reversible: false,
    targetTables: ["stellar_transactions"],
    summary: "Partitions table by month; requires downtime and cannot be automatically rolled back.",
    breakingChanges: [
      {
        description: "Primary key changed to composite (id, created_at)",
        replacement: "Provide created_at in queries",
        issue: 424,
      },
    ],
    rollbackGuidance: "Requires manual table re-creation from backup.",
  },
  "1715000000000-AddBoundedQueueIndexes": {
    version: "1715000000000-AddBoundedQueueIndexes",
    timestamp: 1715000000000,
    title: "Add Bounded Queue Performance Indexes",
    impact: "compatible",
    reversible: true,
    targetTables: ["queue_items"],
    summary: "Indexes to speed up bounded batch processor cursor queries.",
  },
};

/**
 * Fixture A: Valid Sequential Chain (database has applied all migrations)
 */
export const VALID_SEQUENTIAL_CHAIN_FIXTURE = {
  description: "Database is fully migrated and matches application build exactly",
  expectedStatus: "up-to-date" as const,
  applied: [
    { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
    { timestamp: 1705000000000, name: "AddSensitiveActionHashChains1705000000000" },
    { timestamp: 1710000000000, name: "StellarReconciliationPartitioning1710000000000" },
    { timestamp: 1715000000000, name: "AddBoundedQueueIndexes1715000000000" },
  ] as AppliedMigration[],
};

/**
 * Fixture B: Upgrade Ready with Versioned Notes (pending migrations exist)
 */
export const UPGRADE_READY_WITH_NOTES_FIXTURE = {
  description: "Database has applied base schema; has pending migrations with notes",
  expectedStatus: "upgrade-ready" as const,
  applied: [
    { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
    { timestamp: 1705000000000, name: "AddSensitiveActionHashChains1705000000000" },
  ] as AppliedMigration[],
  expectedPending: [
    "1710000000000-StellarReconciliationPartitioning",
    "1715000000000-AddBoundedQueueIndexes",
  ],
  hasBreaking: true,
  irreversible: ["1710000000000-StellarReconciliationPartitioning"],
};

/**
 * Fixture C: Corrupted / Out-of-Order Migration Chain
 */
export const CORRUPTED_OUT_OF_ORDER_FIXTURE = {
  description: "Database has applied migrations out of timestamp order",
  expectedStatus: "incompatible" as const,
  applied: [
    { timestamp: 1705000000000, name: "AddSensitiveActionHashChains1705000000000" },
    { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" }, // out of order!
  ] as AppliedMigration[],
};

/**
 * Fixture D: Future Unknown Migration (database has migration newer than application build)
 */
export const FUTURE_UNKNOWN_VERSION_FIXTURE = {
  description: "Database contains migration not recognized by running application binary",
  expectedStatus: "incompatible" as const,
  applied: [
    { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
    { timestamp: 1705000000000, name: "AddSensitiveActionHashChains1705000000000" },
    { timestamp: 1710000000000, name: "StellarReconciliationPartitioning1710000000000" },
    { timestamp: 1715000000000, name: "AddBoundedQueueIndexes1715000000000" },
    { timestamp: 1799999999999, name: "FutureSorobanUpgrade1799999999999" }, // future unknown!
  ] as AppliedMigration[],
};

/**
 * Fixture E: Duplicate Applied Timestamp
 */
export const DUPLICATE_APPLIED_TIMESTAMP_FIXTURE = {
  description: "Database migration table contains two records with the same timestamp",
  expectedStatus: "incompatible" as const,
  applied: [
    { timestamp: 1700000000000, name: "InitialCoreSchema1700000000000" },
    { timestamp: 1700000000000, name: "ConflictingSchema1700000000000" }, // duplicate!
  ] as AppliedMigration[],
};

