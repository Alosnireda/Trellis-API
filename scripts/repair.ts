#!/usr/bin/env ts-node
/**
 * Dry-run repair tooling with checkpoints CLI.
 *
 * Provides safe previewing (dryRun=true by default) and durable checkpointed repair
 * executions with full rollback capabilities for operational data remediation.
 * Checkpoints are saved as JSON files in `.repair/` (git-ignored) with atomic rename.
 *
 * Usage: see `npm run repair -- --help` or `docs/REPAIR_CLI.md`.
 */
import { FileRepairCheckpointStore } from "../src/common/repair/file-repair-checkpoint-store";
import {
  parseRepairArgs,
  resolveCheckpointId,
  formatRepairReport,
  REPAIR_USAGE,
} from "../src/common/repair/repair-cli";
import {
  RepairAdapter,
  RepairCheckpoint,
  RepairJob,
  RepairPage,
  RepairFinding,
} from "../src/common/repair/repair-job";
import { Role } from "../src/common/guard/roles.enum";

interface GenericRecord {
  id: string;
  status: string;
  orphaned?: boolean;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Demo repair adapter for orphaned and drifted records */
class GenericRepairAdapter implements RepairAdapter<GenericRecord> {
  private records: GenericRecord[] = [
    { id: "rec-1", status: "active", orphaned: false },
    { id: "rec-2", status: "orphaned", orphaned: true },
    { id: "rec-3", status: "stale", orphaned: false },
  ];

  async scan(cursor: string | null, limit: number): Promise<RepairPage<GenericRecord>> {
    const start = cursor ? parseInt(cursor, 10) : 0;
    const records = this.records.slice(start, start + limit);
    const nextCursor = start + limit < this.records.length ? String(start + limit) : null;
    return { records, nextCursor };
  }

  detect(record: GenericRecord): RepairFinding | null {
    if (record.orphaned) {
      return {
        recordId: record.id,
        kind: "orphaned",
        reason: "Parent reference is missing or deleted",
      };
    }
    if (record.status === "stale") {
      return {
        recordId: record.id,
        kind: "inconsistent",
        reason: "Record status marked stale without archival timestamp",
      };
    }
    return null;
  }

  async repair(record: GenericRecord, _finding: RepairFinding): Promise<unknown> {
    const live = this.records.find((r) => r.id === record.id);
    if (!live) throw new Error(`Record ${record.id} not found`);
    const before = { ...live };
    live.orphaned = false;
    live.status = "repaired";
    live.updatedAt = new Date().toISOString();
    return before;
  }

  async restore(recordId: string, before: unknown): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === recordId);
    if (idx !== -1) {
      this.records[idx] = { ...(before as GenericRecord) };
    }
  }
}

function resolveAdapter(jobName: string): RepairAdapter<any> {
  switch (jobName) {
    case "demo-records":
    case "search-index":
    case "orphaned-records":
      return new GenericRepairAdapter();
    default:
      throw new Error(
        `Unknown repair job '${jobName}'. Known jobs: demo-records, search-index, orphaned-records`,
      );
  }
}

function operator() {
  return {
    id: process.env.REPAIR_OPERATOR_ID ?? process.env.USER ?? "repair-operator",
    roles: [Role.MAINTAINER],
  };
}

function summarize(checkpoint: RepairCheckpoint): number {
  console.log(formatRepairReport(checkpoint));
  return checkpoint.status === "completed" && checkpoint.failures.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseRepairArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${REPAIR_USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    console.log(REPAIR_USAGE);
    process.exit(0);
  }

  const store = new FileRepairCheckpointStore(args.checkpointDir);

  if (args.list) {
    const jobs = store.list();
    if (!jobs.length) {
      console.log(`No repair checkpoints found in ${args.checkpointDir}/`);
    } else {
      console.log(`Saved repair checkpoints in ${args.checkpointDir}/:`);
      for (const id of jobs) {
        const cp = await store.load(id);
        console.log(`  - ${id}\tstatus: ${cp?.status ?? "unknown"}\tdryRun: ${cp?.dryRun ?? false}`);
      }
    }
    process.exit(0);
  }

  const checkpointId = resolveCheckpointId(args);

  if (args.report) {
    const checkpoint = await store.load(checkpointId);
    if (!checkpoint) {
      console.error(`No checkpoint found for repair job '${checkpointId}'`);
      process.exit(1);
    }
    console.log(formatRepairReport(checkpoint));
    process.exit(0);
  }

  let adapter: RepairAdapter<any>;
  try {
    adapter = resolveAdapter(args.job!);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  const job = new RepairJob(adapter, store);

  if (args.restart) {
    const existing = await store.load(checkpointId);
    if (existing && existing.journal.length > 0 && !args.force) {
      console.error(
        `Checkpoint '${checkpointId}' holds rollback data for ${existing.journal.length} records. Pass --restart --force to proceed.`,
      );
      process.exit(2);
    }
    await store.delete(checkpointId);
    console.log(`Reset checkpoint '${checkpointId}'`);
  }

  let exitCode = 1;
  try {
    if (args.rollback) {
      console.log(`Rolling back repair job '${checkpointId}'...`);
      const rolledBack = await job.rollback(operator(), checkpointId);
      console.log(formatRepairReport(rolledBack));
      exitCode = 0;
    } else {
      console.log(
        `Starting repair job '${checkpointId}' (dryRun=${args.dryRun}, batchSize=${args.batchSize})...`,
      );
      const result = await job.run(operator(), checkpointId, {
        dryRun: args.dryRun,
        batchSize: args.batchSize,
        maxRepairRetries: args.maxRepairRetries,
      });
      exitCode = summarize(result);
    }
  } catch (error) {
    console.error(`Repair execution failed: ${(error as Error).message}`);
    const cp = await store.load(checkpointId).catch(() => null);
    if (cp) {
      console.error(
        `Checkpoint '${checkpointId}' is resumable at cursor ${cp.cursor ?? "(start)"}. Run with the same ID to continue.`,
      );
    }
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}
