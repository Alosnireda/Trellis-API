/**
 * Versioned Migration Notes & Compatibility Types (#424)
 *
 * Provides machine-readable, structured migration notes and compatibility
 * metadata for off-chain storage migrations and protocol evolution.
 */

export type MigrationImpact =
  | "compatible"
  | "breaking"
  | "security"
  | "deprecation";

export interface BreakingChangeItem {
  description: string;
  replacement: string;
  issue?: number;
}

export interface VersionedMigrationNote {
  version: string;
  timestamp: number;
  title: string;
  impact: MigrationImpact;
  reversible: boolean;
  targetTables: string[];
  summary: string;
  prerequisites?: string[];
  manualSteps?: string[];
  rollbackGuidance?: string;
  breakingChanges?: BreakingChangeItem[];
  author?: string;
  createdAt?: string;
}

/**
 * In-memory / checked-in registry of versioned migration notes.
 */
export const VERSIONED_MIGRATION_NOTES: Record<string, VersionedMigrationNote> = {
  "1700000000000-InitialCoreSchema": {
    version: "1700000000000-InitialCoreSchema",
    timestamp: 1700000000000,
    title: "Initial Core Schema Creation",
    impact: "compatible",
    reversible: true,
    targetTables: ["users", "wallets", "api_keys"],
    summary: "Creates base identity, wallet authorization, and API key credential tables.",
    prerequisites: [],
    manualSteps: [],
    rollbackGuidance: "Standard down migration drops users, wallets, and api_keys tables.",
  },
  "1705000000000-AddSensitiveActionHashChains": {
    version: "1705000000000-AddSensitiveActionHashChains",
    timestamp: 1705000000000,
    title: "Add Sensitive Action Hash Chains for Audit Integrity",
    impact: "security",
    reversible: true,
    targetTables: ["sensitive_action_events", "sensitive_action_chain_heads"],
    summary: "Establishes cryptographic SHA-256 hash chains for sensitive administrative actions.",
    prerequisites: ["1700000000000-InitialCoreSchema"],
    manualSteps: [
      "Ensure database user has CREATE TABLE permissions.",
      "Verify sequence generator initial state.",
    ],
    rollbackGuidance: "Preserve audit logs by exporting table before reverting if needed.",
  },
  "1710000000000-StellarReconciliationPartitioning": {
    version: "1710000000000-StellarReconciliationPartitioning",
    timestamp: 1710000000000,
    title: "Partition Stellar Transaction Ledger by Month",
    impact: "breaking",
    reversible: false,
    targetTables: ["stellar_transactions"],
    summary:
      "Converts flat stellar_transactions table into range-partitioned tables by createdAt month to scale with Horizon ingestion volume.",
    prerequisites: ["1700000000000-InitialCoreSchema"],
    manualSteps: [
      "Stop Horizon polling worker: POST /pause-control/activate { scope: 'horizon_ingestion' }.",
      "Execute database maintenance window migration.",
      "Resume Horizon polling worker.",
    ],
    rollbackGuidance:
      "IRREVERSIBLE AUTOMATICALLY: Range partitions cannot be folded into unpartitioned table via down migration without manual pg_dump export and restore.",
    breakingChanges: [
      {
        description: "Primary key changed to composite (id, created_at) to support PostgreSQL range partitioning.",
        replacement: "Query with created_at filter or use partition-aware repository.",
        issue: 424,
      },
    ],
  },
};

export function getMigrationNote(version: string): VersionedMigrationNote | undefined {
  return VERSIONED_MIGRATION_NOTES[version];
}

