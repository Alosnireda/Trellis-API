import * as fs from "fs";
import * as path from "path";
import { FileRepairCheckpointStore } from "./file-repair-checkpoint-store";
import { RepairCheckpoint } from "./repair-job";

describe("FileRepairCheckpointStore", () => {
  const testDir = path.join(__dirname, "../../../.tmp-repair-test");
  let store: FileRepairCheckpointStore;

  beforeEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    store = new FileRepairCheckpointStore(testDir);
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const sampleCheckpoint: RepairCheckpoint = {
    jobId: "test-repair-1",
    status: "running",
    dryRun: false,
    cursor: "10",
    scanned: 25,
    repaired: 5,
    detected: 5,
    failures: [],
    journal: [{ recordId: "r1", before: { status: "active" } }],
  };

  it("normal path: saves and loads checkpoint correctly", async () => {
    await store.save(sampleCheckpoint);
    const loaded = await store.load("test-repair-1");

    expect(loaded).toEqual(sampleCheckpoint);
  });

  it("returns null when checkpoint does not exist", async () => {
    const loaded = await store.load("non-existent");
    expect(loaded).toBeNull();
  });

  it("lists existing checkpoints", async () => {
    await store.save(sampleCheckpoint);
    await store.save({ ...sampleCheckpoint, jobId: "test-repair-2" });

    const list = store.list().sort();
    expect(list).toEqual(["test-repair-1", "test-repair-2"]);
  });

  it("deletes a checkpoint", async () => {
    await store.save(sampleCheckpoint);
    expect(store.list()).toContain("test-repair-1");

    await store.delete("test-repair-1");
    expect(store.list()).not.toContain("test-repair-1");
    expect(await store.load("test-repair-1")).toBeNull();
  });

  it("failure path: throws on invalid job ID (path traversal protection)", async () => {
    await expect(store.load("../traversal")).rejects.toThrow("Invalid repair job id");
    await expect(
      store.save({ ...sampleCheckpoint, jobId: "../../etc/passwd" }),
    ).rejects.toThrow("Invalid repair job id");
  });

  it("failure path: throws with clear message on corrupted JSON file", async () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "corrupted.json"), "NOT_JSON{{{");

    await expect(store.load("corrupted")).rejects.toThrow(
      "Repair checkpoint",
    );
  });

  it("failure path: throws when file content has mismatched jobId", async () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, "mismatched.json"),
      JSON.stringify({ ...sampleCheckpoint, jobId: "different-id" }),
    );

    await expect(store.load("mismatched")).rejects.toThrow(
      "jobId mismatch",
    );
  });
});
