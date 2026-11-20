import * as fs from "fs";
import * as path from "path";
import { RepairCheckpoint, RepairCheckpointStore } from "./repair-job";

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Durable file-based checkpoint store for the repair CLI tooling.
 *
 * Saves one JSON file per job under a dedicated directory (default `.repair/`).
 * Saves are atomic: writes to a temporary file in the target directory and then
 * renames it, preventing corrupted checkpoints if the process is terminated mid-write.
 * Job IDs are validated to prevent directory traversal attacks.
 */
export class FileRepairCheckpointStore implements RepairCheckpointStore {
  constructor(private readonly dir: string = ".repair") {}

  private fileFor(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error(
        `Invalid repair job id '${jobId}': must match ${JOB_ID_PATTERN}`,
      );
    }
    return path.join(this.dir, `${jobId}.json`);
  }

  async load(jobId: string): Promise<RepairCheckpoint | null> {
    const file = this.fileFor(jobId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: RepairCheckpoint;
    try {
      parsed = JSON.parse(raw) as RepairCheckpoint;
    } catch {
      throw new Error(
        `Repair checkpoint ${file} is not valid JSON; restore it from a backup or delete it to start over with --restart --force`,
      );
    }
    if (!parsed || typeof parsed !== "object" || parsed.jobId !== jobId) {
      throw new Error(
        `Repair checkpoint ${file} is corrupt (jobId mismatch); restore it from a backup or delete it to start over with --restart --force`,
      );
    }
    return parsed;
  }

  async save(checkpoint: RepairCheckpoint): Promise<void> {
    const file = this.fileFor(checkpoint.jobId);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  /**
   * Lists all existing checkpoint job IDs in the checkpoint directory.
   */
  list(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.replace(/\.json$/, ""));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Deletes a checkpoint (e.g. for --restart --force).
   */
  async delete(jobId: string): Promise<void> {
    const file = this.fileFor(jobId);
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
