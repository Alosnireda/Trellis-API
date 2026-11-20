/*
 * Deterministic contract upgrade compatibility snapshots (#333).
 *
 * A snapshot records every assumption the API makes about the deployed
 * oracle contract: the invocation ABI verify() accepts, the storage keys it
 * reads, the event schemas it decodes and the decoder's hard limits. It is
 * serialized canonically, so the same code always yields byte-identical
 * output, and the committed baseline is checked by digest.
 *
 * Comparing the committed baseline with a candidate classifies each change
 * as `additive` (an upgrade the API tolerates — e.g. an appended event field
 * or new kind) or `breaking` (previously valid contract data would no longer
 * be accepted). See docs/CONTRACT_UPGRADE_COMPATIBILITY_SNAPSHOTS.md.
 */

import { createHash } from "crypto";
import { canonicalJson } from "../../../common/serialization/canonical-json";
import {
  MAX_CONTRACT_EVENTS_PER_TRANSACTION,
  MAX_ORACLE_EVENT_DATA_FIELDS,
  ORACLE_CONTRACT_EVENT_SCHEMAS,
  ORACLE_EVENT_NAMESPACE,
  OracleEventSchema,
} from "../events/oracle-contract-events";
import {
  FEED_HISTORY_KEY,
  SUBMIT_PRICE_ARGUMENT_TYPES,
  SUBMIT_PRICE_FUNCTION,
} from "../services/stellar-oracle.adapter";

export const ORACLE_CONTRACT_SNAPSHOT_SCHEMA =
  "trellis.oracle.contract-compat-snapshot.v1";

export interface SnapshotEventField {
  name: string;
  type: string;
}

export interface OracleContractSnapshot {
  schema: string;
  functions: Record<string, { args: string[] }>;
  storage: Record<string, { key: string; durability: string }>;
  events: {
    namespace: string;
    kinds: Record<string, Array<{ version: number; fields: SnapshotEventField[] }>>;
  };
  limits: Record<string, number>;
}

/** On-disk form: the snapshot plus its sha256 over canonical JSON. */
export interface OracleContractSnapshotFile {
  digest: string;
  snapshot: OracleContractSnapshot;
}

export interface SnapshotSources {
  functions: Record<string, readonly string[]>;
  storage: Record<string, { key: string; durability: string }>;
  namespace: string;
  events: Readonly<Record<string, readonly OracleEventSchema[]>>;
  limits: Record<string, number>;
}

/** What the running code depends on today. */
export function currentSnapshotSources(): SnapshotSources {
  return {
    functions: { [SUBMIT_PRICE_FUNCTION]: SUBMIT_PRICE_ARGUMENT_TYPES },
    storage: { feedHistory: { key: FEED_HISTORY_KEY, durability: "persistent" } },
    namespace: ORACLE_EVENT_NAMESPACE,
    events: ORACLE_CONTRACT_EVENT_SCHEMAS,
    limits: {
      maxContractEventsPerTransaction: MAX_CONTRACT_EVENTS_PER_TRANSACTION,
      maxEventDataFields: MAX_ORACLE_EVENT_DATA_FIELDS,
    },
  };
}

export function buildOracleContractSnapshot(
  sources: SnapshotSources = currentSnapshotSources(),
): OracleContractSnapshot {
  const kinds: OracleContractSnapshot["events"]["kinds"] = {};
  for (const [kind, versions] of Object.entries(sources.events))
    kinds[kind] = [...versions]
      .sort((a, b) => a.version - b.version)
      .map((v) => ({ version: v.version, fields: v.fields.map((f) => ({ name: f.name, type: f.type })) }));
  const functions: OracleContractSnapshot["functions"] = {};
  for (const [name, args] of Object.entries(sources.functions)) functions[name] = { args: [...args] };
  // Round-trip through canonical JSON so key order never depends on source order.
  return JSON.parse(
    canonicalJson({
      schema: ORACLE_CONTRACT_SNAPSHOT_SCHEMA,
      functions,
      storage: sources.storage,
      events: { namespace: sources.namespace, kinds },
      limits: sources.limits,
    }),
  );
}

export function snapshotDigest(snapshot: OracleContractSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** Byte-stable file contents: canonical key order, 2-space indent, trailing newline. */
export function serializeSnapshotFile(snapshot: OracleContractSnapshot): string {
  const file: OracleContractSnapshotFile = { digest: snapshotDigest(snapshot), snapshot };
  return JSON.stringify(JSON.parse(canonicalJson(file)), null, 2) + "\n";
}

export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

/** Parses a baseline file and refuses hand edits or truncation (digest check). */
export function parseSnapshotFile(contents: string): OracleContractSnapshot {
  let file: OracleContractSnapshotFile;
  try {
    file = JSON.parse(contents);
  } catch {
    throw new SnapshotIntegrityError("Snapshot file is not valid JSON");
  }
  if (!file || typeof file.digest !== "string" || !file.snapshot || typeof file.snapshot !== "object")
    throw new SnapshotIntegrityError("Snapshot file must contain { digest, snapshot }");
  if (file.snapshot.schema !== ORACLE_CONTRACT_SNAPSHOT_SCHEMA)
    throw new SnapshotIntegrityError(
      `Unsupported snapshot schema ${String(file.snapshot.schema)}; expected ${ORACLE_CONTRACT_SNAPSHOT_SCHEMA}`,
    );
  let actual: string;
  try {
    actual = snapshotDigest(file.snapshot);
  } catch (error) {
    throw new SnapshotIntegrityError(`Snapshot is not canonicalizable: ${(error as Error).message}`);
  }
  if (actual !== file.digest)
    throw new SnapshotIntegrityError(
      `Snapshot digest mismatch (recorded ${file.digest}, computed ${actual}); the file was edited by hand`,
    );
  return file.snapshot;
}

export type ChangeSeverity = "breaking" | "additive";

export interface SnapshotChange {
  severity: ChangeSeverity;
  path: string;
  message: string;
}

export interface CompatibilityReport {
  identical: boolean;
  compatible: boolean;
  baselineDigest: string;
  candidateDigest: string;
  /** Sorted by path, then severity, so reports are deterministic. */
  changes: SnapshotChange[];
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function compareRecords<T>(
  prefix: string,
  baseline: Record<string, T>,
  candidate: Record<string, T>,
  changes: SnapshotChange[],
  onBoth: (key: string, before: T, after: T) => void,
): void {
  for (const key of Object.keys(baseline))
    if (!(key in candidate))
      changes.push({ severity: "breaking", path: `${prefix}.${key}`, message: "removed" });
    else onBoth(key, baseline[key], candidate[key]);
  for (const key of Object.keys(candidate))
    if (!(key in baseline)) changes.push({ severity: "additive", path: `${prefix}.${key}`, message: "added" });
}

/**
 * Classifies the upgrade from `baseline` to `candidate`. Breaking means some
 * contract data the baseline accepted would now be refused or misread.
 */
export function compareOracleContractSnapshots(
  baseline: OracleContractSnapshot,
  candidate: OracleContractSnapshot,
): CompatibilityReport {
  const changes: SnapshotChange[] = [];
  if (baseline.schema !== candidate.schema)
    changes.push({ severity: "breaking", path: "schema", message: `${baseline.schema} -> ${candidate.schema}` });

  compareRecords("functions", baseline.functions, candidate.functions, changes, (name, before, after) => {
    // verify() matches arity and types exactly, so any change is breaking.
    if (!same(before.args, after.args))
      changes.push({
        severity: "breaking",
        path: `functions.${name}.args`,
        message: `(${before.args.join(", ")}) -> (${after.args.join(", ")})`,
      });
  });

  compareRecords("storage", baseline.storage, candidate.storage, changes, (name, before, after) => {
    if (!same(before, after))
      changes.push({
        severity: "breaking",
        path: `storage.${name}`,
        message: `${before.durability}:${before.key} -> ${after.durability}:${after.key}`,
      });
  });

  if (baseline.events.namespace !== candidate.events.namespace)
    changes.push({
      severity: "breaking",
      path: "events.namespace",
      message: `${baseline.events.namespace} -> ${candidate.events.namespace}`,
    });

  compareRecords("events.kinds", baseline.events.kinds, candidate.events.kinds, changes, (kind, before, after) => {
    for (const version of before) {
      const match = after.find((v) => v.version === version.version);
      if (!match)
        changes.push({ severity: "breaking", path: `events.kinds.${kind}.v${version.version}`, message: "removed" });
      else if (!same(match.fields, version.fields))
        changes.push({
          severity: "breaking",
          path: `events.kinds.${kind}.v${version.version}`,
          message: "fields changed; already-emitted events would no longer decode",
        });
    }
    const known = new Set(before.map((v) => v.version));
    for (const version of after.filter((v) => !known.has(v.version))) {
      const previous = after.find((v) => v.version === version.version - 1);
      const appendOnly =
        !!previous &&
        version.fields.length > previous.fields.length &&
        same(version.fields.slice(0, previous.fields.length), previous.fields);
      changes.push(
        appendOnly
          ? { severity: "additive", path: `events.kinds.${kind}.v${version.version}`, message: "appended fields" }
          : {
              severity: "breaking",
              path: `events.kinds.${kind}.v${version.version}`,
              message: "new version does not append to the previous one",
            },
      );
    }
  });

  compareRecords("limits", baseline.limits, candidate.limits, changes, (name, before, after) => {
    if (after < before)
      changes.push({ severity: "breaking", path: `limits.${name}`, message: `lowered ${before} -> ${after}` });
    else if (after > before)
      changes.push({ severity: "additive", path: `limits.${name}`, message: `raised ${before} -> ${after}` });
  });

  changes.sort((a, b) =>
    a.path === b.path ? a.severity.localeCompare(b.severity) : a.path < b.path ? -1 : 1,
  );
  const baselineDigest = snapshotDigest(baseline);
  const candidateDigest = snapshotDigest(candidate);
  return {
    identical: baselineDigest === candidateDigest,
    compatible: changes.every((c) => c.severity === "additive"),
    baselineDigest,
    candidateDigest,
    changes,
  };
}

/** Roles that may rewrite a committed baseline (matches event-schema-drift). */
export const SNAPSHOT_UPDATE_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "maintainer",
  "platform-engineer",
]);

export interface SnapshotUpdateRequest {
  actorId: string;
  role: string;
  allowBreaking?: boolean;
  reason?: string;
}

export class SnapshotUpdateAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotUpdateAuthorizationError";
  }
}

/**
 * Accepting a new baseline is an authorization decision: any role in
 * {@link SNAPSHOT_UPDATE_ROLES} may record additive changes; breaking
 * changes additionally require an explicit `allowBreaking` and a reason.
 */
export function assertSnapshotUpdateAuthorized(
  request: SnapshotUpdateRequest,
  report: CompatibilityReport,
): void {
  if (!request.actorId)
    throw new SnapshotUpdateAuthorizationError("An actor id is required to update the baseline");
  if (!SNAPSHOT_UPDATE_ROLES.has((request.role ?? "").toLowerCase()))
    throw new SnapshotUpdateAuthorizationError(
      `Role '${request.role}' may not update the contract compatibility baseline`,
    );
  if (!report.compatible) {
    if (!request.allowBreaking)
      throw new SnapshotUpdateAuthorizationError(
        "Baseline update contains breaking changes; pass --allow-breaking with --reason after coordinating the release",
      );
    if (!request.reason || request.reason.trim().length < 10)
      throw new SnapshotUpdateAuthorizationError("Breaking baseline updates need a --reason of at least 10 characters");
  }
}
