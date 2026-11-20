/*
 * CLI for oracle contract compatibility snapshots (#333). Kept in src/ so the
 * spec can drive it; scripts/check-oracle-contract-snapshot.ts is a wrapper.
 *
 *   check (default)  exit 0 if the baseline matches, 1 on drift, 2 on usage/integrity errors
 *   --update --actor-role <role> [--allow-breaking --reason "<why>"]
 *                    rewrite the baseline (atomic; rerunning is a no-op)
 *   --json           machine-readable report
 */

import * as fs from "fs";
import * as path from "path";
import {
  OracleContractSnapshot,
  SnapshotIntegrityError,
  SnapshotUpdateAuthorizationError,
  assertSnapshotUpdateAuthorized,
  buildOracleContractSnapshot,
  compareOracleContractSnapshots,
  parseSnapshotFile,
  serializeSnapshotFile,
} from "./oracle-contract-snapshot";

export const DEFAULT_SNAPSHOT_PATH = path.join(
  __dirname,
  "__snapshots__",
  "oracle-contract.snapshot.json",
);

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ERROR = 2;

export interface SnapshotCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  env: Record<string, string | undefined>;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Writes via a temp file + rename so an interrupted run never leaves a torn baseline. */
function writeAtomically(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, contents, "utf8");
  fs.renameSync(temp, target);
}

export function runSnapshotCli(
  args: string[],
  io: SnapshotCliIo,
  candidate: OracleContractSnapshot = buildOracleContractSnapshot(),
): number {
  const json = args.includes("--json");
  const update = args.includes("--update");
  const target = path.resolve(flag(args, "--baseline") ?? DEFAULT_SNAPSHOT_PATH);

  let baseline: OracleContractSnapshot | null = null;
  if (fs.existsSync(target)) {
    try {
      baseline = parseSnapshotFile(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (!(error instanceof SnapshotIntegrityError)) throw error;
      io.error(`Baseline ${target} is invalid: ${error.message}`);
      // A corrupt baseline can only be replaced by an authorized update.
      if (!update) return EXIT_ERROR;
    }
  } else if (!update) {
    io.error(`No baseline at ${target}; create one with --update --actor-role <role>`);
    return EXIT_ERROR;
  }

  const report = compareOracleContractSnapshots(baseline ?? candidate, candidate);
  if (!baseline) {
    // First baseline (or replacing a corrupt one): nothing to diff against.
    report.identical = false;
  }

  if (!update) {
    if (json) io.log(JSON.stringify(report));
    else if (report.identical) io.log(`✅ Oracle contract snapshot matches baseline (${report.baselineDigest})`);
    else {
      io.log(`❌ Oracle contract snapshot drifted (${report.compatible ? "additive only" : "BREAKING"})`);
      for (const change of report.changes) io.log(`  [${change.severity}] ${change.path}: ${change.message}`);
      io.log("Review the changes, then run with --update --actor-role <role> to accept them.");
    }
    return report.identical ? EXIT_OK : EXIT_DRIFT;
  }

  if (report.identical && baseline) {
    io.log("Baseline already up to date; nothing written.");
    return EXIT_OK;
  }
  const actorRole = flag(args, "--actor-role") ?? io.env.SNAPSHOT_ACTOR_ROLE ?? "";
  try {
    assertSnapshotUpdateAuthorized(
      {
        actorId: io.env.USER ?? io.env.GITHUB_ACTOR ?? "",
        role: actorRole,
        allowBreaking: args.includes("--allow-breaking"),
        reason: flag(args, "--reason"),
      },
      report,
    );
  } catch (error) {
    if (!(error instanceof SnapshotUpdateAuthorizationError)) throw error;
    io.error(error.message);
    return EXIT_ERROR;
  }
  writeAtomically(target, serializeSnapshotFile(candidate));
  // Audit line for the PR / CI log; the file itself stays deterministic.
  io.log(
    JSON.stringify({
      event: "oracle_contract_snapshot_updated",
      actor: io.env.USER ?? io.env.GITHUB_ACTOR,
      role: actorRole,
      reason: flag(args, "--reason") ?? null,
      from: baseline ? report.baselineDigest : null,
      to: report.candidateDigest,
      changes: report.changes,
    }),
  );
  return EXIT_OK;
}
