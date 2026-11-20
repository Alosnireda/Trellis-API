import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ORACLE_CONTRACT_EVENT_SCHEMAS } from "../events/oracle-contract-events";
import {
  CompatibilityReport,
  OracleContractSnapshot,
  SnapshotIntegrityError,
  SnapshotUpdateAuthorizationError,
  assertSnapshotUpdateAuthorized,
  buildOracleContractSnapshot,
  compareOracleContractSnapshots,
  currentSnapshotSources,
  parseSnapshotFile,
  serializeSnapshotFile,
} from "./oracle-contract-snapshot";
import {
  DEFAULT_SNAPSHOT_PATH,
  EXIT_DRIFT,
  EXIT_ERROR,
  EXIT_OK,
  runSnapshotCli,
} from "./oracle-contract-snapshot.cli";

/*
 * Deterministic contract upgrade compatibility snapshots (#333).
 */

const clone = (s: OracleContractSnapshot): OracleContractSnapshot => JSON.parse(JSON.stringify(s));

describe("oracle contract compatibility snapshot (#333)", () => {
  describe("committed baseline", () => {
    it("matches the code; if this fails, run `npm run contract:snapshot:check` and review the drift", () => {
      const committed = fs.readFileSync(DEFAULT_SNAPSHOT_PATH, "utf8");
      expect(serializeSnapshotFile(buildOracleContractSnapshot())).toBe(committed);
    });

    it("parses and passes its own integrity check", () => {
      expect(parseSnapshotFile(fs.readFileSync(DEFAULT_SNAPSHOT_PATH, "utf8"))).toEqual(
        buildOracleContractSnapshot(),
      );
    });
  });

  describe("determinism", () => {
    it("is byte-identical across rebuilds and independent of source key order", () => {
      const sources = currentSnapshotSources();
      const reversed = {
        ...sources,
        events: Object.fromEntries(
          Object.entries(sources.events)
            .reverse()
            .map(([kind, versions]) => [kind, [...versions].reverse()]),
        ),
        limits: Object.fromEntries(Object.entries(sources.limits).reverse()),
      };
      const a = serializeSnapshotFile(buildOracleContractSnapshot());
      expect(serializeSnapshotFile(buildOracleContractSnapshot())).toBe(a);
      expect(serializeSnapshotFile(buildOracleContractSnapshot(reversed))).toBe(a);
    });

    it("captures every registered event kind and the submit_price ABI", () => {
      const snapshot = buildOracleContractSnapshot();
      expect(Object.keys(snapshot.events.kinds).sort()).toEqual(Object.keys(ORACLE_CONTRACT_EVENT_SCHEMAS).sort());
      expect(snapshot.functions.submit_price.args).toHaveLength(6);
      expect(snapshot.storage.feedHistory).toEqual({ key: "feed_his", durability: "persistent" });
    });
  });

  describe("classification", () => {
    const base = buildOracleContractSnapshot();
    const diff = (mutate: (s: OracleContractSnapshot) => void): CompatibilityReport => {
      const next = clone(base);
      mutate(next);
      return compareOracleContractSnapshots(base, next);
    };

    it("reports identical snapshots as compatible with no changes", () => {
      expect(compareOracleContractSnapshots(base, clone(base))).toMatchObject({
        identical: true,
        compatible: true,
        changes: [],
      });
    });

    it.each([
      [
        "an appended event version",
        (s) =>
          s.events.kinds.staked.push({
            version: 2,
            fields: [...s.events.kinds.staked[0].fields, { name: "correlation_id", type: "symbol" }],
          }),
        "events.kinds.staked.v2",
      ],
      ["a new event kind", (s) => (s.events.kinds.paused = [{ version: 1, fields: [] }]), "events.kinds.paused"],
      ["a new function", (s) => (s.functions.submit_batch = { args: ["scvVec"] }), "functions.submit_batch"],
      ["a raised limit", (s) => (s.limits.maxEventDataFields += 4), "limits.maxEventDataFields"],
    ] as Array<[string, (s: OracleContractSnapshot) => void, string]>)("treats %s as additive", (_label, mutate, changedPath) => {
      const report = diff(mutate);
      expect(report).toMatchObject({ identical: false, compatible: true });
      expect(report.changes).toEqual([expect.objectContaining({ severity: "additive", path: changedPath })]);
    });

    it.each([
      ["a removed event kind", (s) => delete s.events.kinds.withdrawn, "events.kinds.withdrawn"],
      ["a removed event version", (s) => s.events.kinds.price.pop(), "events.kinds.price.v2"],
      ["a retyped event field", (s) => (s.events.kinds.price[0].fields[1].type = "u64"), "events.kinds.price.v1"],
      [
        "a non-appending new version",
        (s) => s.events.kinds.staked.push({ version: 2, fields: s.events.kinds.staked[0].fields.slice(1) }),
        "events.kinds.staked.v2",
      ],
      ["a changed namespace", (s) => (s.events.namespace = "oracle2"), "events.namespace"],
      ["a changed submit_price arity", (s) => s.functions.submit_price.args.push("scvU64"), "functions.submit_price.args"],
      ["a removed function", (s) => delete s.functions.submit_price, "functions.submit_price"],
      ["a renamed storage key", (s) => (s.storage.feedHistory.key = "feed_hist"), "storage.feedHistory"],
      ["a lowered limit", (s) => (s.limits.maxContractEventsPerTransaction = 10), "limits.maxContractEventsPerTransaction"],
      ["a snapshot schema change", (s) => (s.schema = "other"), "schema"],
    ] as Array<[string, (s: OracleContractSnapshot) => void, string]>)("treats %s as breaking", (_label, mutate, changedPath) => {
      const report = diff(mutate);
      expect(report.compatible).toBe(false);
      expect(report.changes).toContainEqual(expect.objectContaining({ severity: "breaking", path: changedPath }));
    });

    it("orders changes deterministically", () => {
      const a = diff((s) => {
        delete s.events.kinds.withdrawn;
        s.limits.maxEventDataFields += 1;
        s.functions.z = { args: [] };
      });
      expect(a.changes.map((c) => c.path)).toEqual([...a.changes.map((c) => c.path)].sort());
    });
  });

  describe("failure path: baseline integrity", () => {
    const valid = serializeSnapshotFile(buildOracleContractSnapshot());
    it.each([
      ["invalid JSON", valid.slice(0, 40)],
      ["a missing digest", JSON.stringify({ snapshot: buildOracleContractSnapshot() })],
      ["a hand edit", valid.replace('"feed_his"', '"feed_hist"')],
      ["an unknown schema", valid.replace("contract-compat-snapshot.v1", "contract-compat-snapshot.v9")],
    ])("refuses %s", (_label, contents) => {
      expect(() => parseSnapshotFile(contents)).toThrow(SnapshotIntegrityError);
    });
  });

  describe("authorization path", () => {
    const base = buildOracleContractSnapshot();
    const additive = compareOracleContractSnapshots(base, { ...clone(base), limits: { ...base.limits, maxEventDataFields: 99 } });
    const breaking = compareOracleContractSnapshots(base, { ...clone(base), functions: {} });

    it.each(["maintainer", "ADMIN", "platform-engineer"])("lets %s record additive changes", (role) => {
      expect(() => assertSnapshotUpdateAuthorized({ actorId: "a", role }, additive)).not.toThrow();
    });

    it.each([
      ["no actor", { actorId: "", role: "maintainer" }, additive],
      ["an unauthorized role", { actorId: "a", role: "developer" }, additive],
      ["breaking without opt-in", { actorId: "a", role: "maintainer", reason: "coordinated release" }, breaking],
      ["breaking without a reason", { actorId: "a", role: "maintainer", allowBreaking: true }, breaking],
      ["breaking with a trivial reason", { actorId: "a", role: "maintainer", allowBreaking: true, reason: "ok" }, breaking],
    ])("refuses %s", (_label, request, report) => {
      expect(() => assertSnapshotUpdateAuthorized(request as any, report)).toThrow(SnapshotUpdateAuthorizationError);
    });

    it("accepts a breaking change with explicit opt-in and a reason", () => {
      expect(() =>
        assertSnapshotUpdateAuthorized(
          { actorId: "a", role: "maintainer", allowBreaking: true, reason: "coordinated v3 contract release" },
          breaking,
        ),
      ).not.toThrow();
    });
  });

  describe("CLI (normal, failure, retry and authorization paths)", () => {
    let dir: string;
    let file: string;
    let out: string[];
    let err: string[];
    const io = (env: Record<string, string> = { USER: "tester" }) => ({
      log: (l: string) => out.push(l),
      error: (l: string) => err.push(l),
      env,
    });
    const run = (args: string[], candidate?: OracleContractSnapshot, env?: Record<string, string>) =>
      runSnapshotCli([...args, "--baseline", file], io(env), candidate);

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-snapshot-"));
      file = path.join(dir, "snapshot.json");
      out = [];
      err = [];
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("requires a baseline to check against", () => {
      expect(run([])).toBe(EXIT_ERROR);
    });

    it("creates, verifies and idempotently re-writes a baseline", () => {
      expect(run(["--update", "--actor-role", "maintainer"])).toBe(EXIT_OK);
      const first = fs.readFileSync(file, "utf8");
      expect(run([])).toBe(EXIT_OK);
      expect(run(["--update", "--actor-role", "maintainer"])).toBe(EXIT_OK);
      expect(out).toContain("Baseline already up to date; nothing written.");
      expect(fs.readFileSync(file, "utf8")).toBe(first);
      expect(fs.readdirSync(dir)).toEqual(["snapshot.json"]); // no temp files left behind
    });

    it("exits 1 on drift and reports it as JSON", () => {
      run(["--update", "--actor-role", "maintainer"]);
      const drifted = clone(buildOracleContractSnapshot());
      delete drifted.events.kinds.withdrawn;
      expect(run(["--json"], drifted)).toBe(EXIT_DRIFT);
      expect(JSON.parse(out[out.length - 1])).toMatchObject({ compatible: false, identical: false });
    });

    it("refuses an unauthorized or unacknowledged breaking update and leaves the baseline intact", () => {
      run(["--update", "--actor-role", "maintainer"]);
      const before = fs.readFileSync(file, "utf8");
      const drifted = clone(buildOracleContractSnapshot());
      delete drifted.functions.submit_price;
      expect(run(["--update", "--actor-role", "developer"], drifted)).toBe(EXIT_ERROR);
      expect(run(["--update", "--actor-role", "maintainer"], drifted)).toBe(EXIT_ERROR);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(
        run(["--update", "--actor-role", "maintainer", "--allow-breaking", "--reason", "coordinated v3 release"], drifted),
      ).toBe(EXIT_OK);
      expect(parseSnapshotFile(fs.readFileSync(file, "utf8"))).toEqual(drifted);
    });

    it("recovers from a corrupt baseline only through an authorized update", () => {
      fs.writeFileSync(file, "{ truncated");
      expect(run([])).toBe(EXIT_ERROR);
      expect(run(["--update", "--actor-role", "developer"])).toBe(EXIT_ERROR);
      expect(run(["--update", "--actor-role", "maintainer"])).toBe(EXIT_OK);
      expect(run([])).toBe(EXIT_OK);
    });
  });
});
