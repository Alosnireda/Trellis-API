#!/usr/bin/env ts-node
/**
 * Storage TTL check (#337). Read-only.
 *
 * Usage:
 *   npm run storage-ttl:check -- snapshot.json
 *
 * Reads a snapshot of tracked entries, prints the TTL report and repair plan,
 * and exits 1 when anything needs attention (2 on unreadable or malformed
 * input). It never talks to the network or changes any entry; run the repair
 * through `StorageTtlService.repair` with an ADMIN actor.
 */

import * as fs from "fs";
import {
  assessEntry,
  buildReport,
  planRepairs,
  validatePolicy,
} from "../src/storage-ttl/storage-ttl.policy";
import {
  DEFAULT_TTL_POLICY,
  StorageDurability,
  TtlPolicy,
} from "../src/storage-ttl/storage-ttl.types";

interface SnapshotEntry {
  key: string;
  durability: StorageDurability;
  label?: string;
  liveUntilLedger: number | null;
  archived?: boolean;
}

interface Snapshot {
  currentLedger: number;
  policy?: Partial<TtlPolicy>;
  entries: SnapshotEntry[];
}

function main(): number {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run storage-ttl:check -- <snapshot.json>");
    return 2;
  }

  let snapshot: Snapshot;
  let policy: TtlPolicy;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Number.isFinite(snapshot?.currentLedger) ||
      !Array.isArray(snapshot.entries)
    ) {
      throw new Error(
        "snapshot needs a numeric currentLedger and an entries array",
      );
    }
    const keys = new Set<string>();
    for (const e of snapshot.entries) {
      if (
        !e?.key ||
        (e.durability !== "persistent" && e.durability !== "temporary")
      ) {
        throw new Error(
          "every entry needs a key and a durability of persistent|temporary",
        );
      }
      if (keys.has(e.key)) throw new Error(`duplicate key ${e.key}`);
      keys.add(e.key);
    }
    policy = validatePolicy({ ...DEFAULT_TTL_POLICY, ...snapshot.policy });
  } catch (err) {
    console.error(`Cannot use snapshot: ${(err as Error).message}`);
    return 2;
  }

  const assessments = snapshot.entries.map((e) =>
    assessEntry(
      { key: e.key, durability: e.durability, label: e.label },
      { liveUntilLedger: e.liveUntilLedger, archived: e.archived },
      snapshot.currentLedger,
      policy,
    ),
  );
  const report = buildReport(assessments, snapshot.currentLedger);
  console.log(JSON.stringify({ report, plan: planRepairs(report) }, null, 2));
  return report.needsAttention ? 1 : 0;
}

process.exit(main());
