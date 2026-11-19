import {
  buildReproducibleReleaseArtifact,
  verifyReleaseArtifact,
  computeSha256,
  canonicalStringify,
  normalizeArtifactContent,
  ReproducibleReleaseManifest,
} from "./reproducible-artifact";

describe("Reproducible Release Artifacts and Verification Checks (#435)", () => {
  const sampleFiles = [
    {
      path: "docs/openapi.json",
      content: JSON.stringify({ openapi: "3.0.0", info: { title: "Trellis API", version: "0.1.0" } }),
    },
    {
      path: "dist/main.js",
      content: "console.log('Trellis API initialized');\n",
    },
    {
      path: "package.json",
      content: JSON.stringify({ name: "trellis-api", version: "0.1.0" }),
    },
  ];

  const sampleMigrations = [
    {
      filename: "1787313600000-create-audit.ts",
      content: `
        export class CreateAudit1787313600000 {
          async up(queryRunner) { await queryRunner.query('CREATE TABLE audit...'); }
          async down(queryRunner) { await queryRunner.query('DROP TABLE audit...'); }
        }
      `,
    },
  ];

  describe("Normal Path: Deterministic Canonical Artifact Generation", () => {
    it("should generate a canonical manifest with sorted files and deterministic rootDigest", () => {
      // Reordered input files to verify sorting
      const reorderedFiles = [sampleFiles[2], sampleFiles[0], sampleFiles[1]];

      const manifest1 = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: sampleFiles,
        migrations: sampleMigrations,
        canonicalTimestamp: "2026-11-19T00:00:00.000Z",
      });

      const manifest2 = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: reorderedFiles,
        migrations: sampleMigrations,
        canonicalTimestamp: "2026-11-19T00:00:00.000Z",
      });

      expect(manifest1.files.map((f) => f.path)).toEqual([
        "dist/main.js",
        "docs/openapi.json",
        "package.json",
      ]);
      expect(manifest1.rootDigest).toBe(manifest2.rootDigest);
      expect(manifest1.rootDigest).toHaveLength(64);
    });

    it("should normalize CRLF line endings to LF to prevent cross-platform hash divergence", () => {
      const crlfContent = "line 1\r\nline 2\r\nline 3\r\n";
      const lfContent = "line 1\nline 2\nline 3\n";

      expect(computeSha256(crlfContent)).toBe(computeSha256(lfContent));
    });

    it("should successfully verify all files against a valid manifest", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: sampleFiles,
        migrations: sampleMigrations,
      });

      const fileMap = new Map<string, string | Buffer>();
      sampleFiles.forEach((f) => fileMap.set(f.path, f.content));

      const report = await verifyReleaseArtifact(manifest, fileMap, {
        requiredArtifactPatterns: ["docs/openapi.json", "dist/main.js"],
      });

      expect(report.verified).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.checkedFilesCount).toBe(3);
      expect(report.migrationSafety.safe).toBe(true);
    });
  });

  describe("Failure Path: Tampering & Integrity Violations", () => {
    it("should fail verification when a file content has been altered", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: sampleFiles,
      });

      const fileMap = new Map<string, string | Buffer>();
      sampleFiles.forEach((f) => fileMap.set(f.path, f.content));
      // Tamper with main.js
      fileMap.set("dist/main.js", "console.log('INJECTED BACKDOOR');\n");

      const report = await verifyReleaseArtifact(manifest, fileMap);

      expect(report.verified).toBe(false);
      expect(report.errors.some((e) => e.includes("Digest mismatch for dist/main.js"))).toBe(true);
    });

    it("should fail verification when the manifest rootDigest has been tampered with", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: sampleFiles,
      });

      // Tamper with declared root digest
      const tamperedManifest: ReproducibleReleaseManifest = {
        ...manifest,
        rootDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      };

      const fileMap = new Map<string, string | Buffer>();
      sampleFiles.forEach((f) => fileMap.set(f.path, f.content));

      const report = await verifyReleaseArtifact(tamperedManifest, fileMap);

      expect(report.verified).toBe(false);
      expect(report.errors.some((e) => e.includes("Manifest root digest mismatch"))).toBe(true);
    });

    it("should fail verification when a mandatory artifact is missing", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: [sampleFiles[1]], // Missing openapi.json
      });

      const fileMap = new Map<string, string | Buffer>();
      fileMap.set(sampleFiles[1].path, sampleFiles[1].content);

      const report = await verifyReleaseArtifact(manifest, fileMap, {
        requiredArtifactPatterns: ["docs/openapi.json"],
      });

      expect(report.verified).toBe(false);
      expect(report.errors.some((e) => e.includes("Missing mandatory release artifact"))).toBe(true);
    });

    it("should flag unsafe migrations missing a down() rollback method", async () => {
      const irreversibleMigration = [
        {
          filename: "1787313600001-unsafe.ts",
          content: `export class UnsafeMigration { async up() {} }`, // Missing down()
        },
      ];

      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: sampleFiles,
        migrations: irreversibleMigration,
      });

      const fileMap = new Map<string, string | Buffer>();
      sampleFiles.forEach((f) => fileMap.set(f.path, f.content));

      const report = await verifyReleaseArtifact(manifest, fileMap);

      expect(report.verified).toBe(false);
      expect(report.migrationSafety.safe).toBe(false);
      expect(report.errors.some((e) => e.includes("not reversible"))).toBe(true);
    });
  });

  describe("Retry Path: Transient File Verification Failures", () => {
    it("should retry transient fetch errors and succeed within maxAttempts", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: [{ path: "file-transient.txt", content: "data-123" }],
      });

      let fetchCount = 0;
      const retryLog: number[] = [];

      const flakyMap = {
        get: (path: string) => {
          fetchCount++;
          if (fetchCount < 3) {
            return undefined; // Simulating transient I/O miss
          }
          return "data-123";
        },
      } as unknown as Map<string, string | Buffer>;

      const report = await verifyReleaseArtifact(manifest, flakyMap, {
        retryOptions: {
          maxAttempts: 3,
          backoffMs: 10,
          onRetry: (attempt) => retryLog.push(attempt),
        },
      });

      expect(report.verified).toBe(true);
      expect(retryLog).toEqual([1, 2]);
      expect(fetchCount).toBe(3);
    });

    it("should fail gracefully when retries are exhausted", async () => {
      const manifest = buildReproducibleReleaseArtifact({
        releaseId: "v0.1.0",
        version: "0.1.0",
        commitHash: "a1b2c3d4e5f6789012345678901234567890abcd",
        files: [{ path: "file-never.txt", content: "permanent-miss" }],
      });

      const emptyMap = new Map<string, string | Buffer>();

      const report = await verifyReleaseArtifact(manifest, emptyMap, {
        retryOptions: {
          maxAttempts: 2,
          backoffMs: 10,
        },
      });

      expect(report.verified).toBe(false);
      expect(report.errors[0]).toContain("after 2 attempt(s)");
    });
  });
});

