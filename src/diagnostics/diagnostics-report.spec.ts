import {
  buildJsonReport,
  DIAGNOSTIC_SECTIONS,
  diagnosticsExitCode,
  parseDiagnosticsArgs,
  redactSecrets,
  summarizeChecks,
} from "./diagnostics-report";
import { DiagnosticCheck } from "./diagnostics-checks";

const check = (
  status: DiagnosticCheck["status"],
  extra: Partial<DiagnosticCheck> = {},
): DiagnosticCheck => ({
  name: `n-${status}`,
  status,
  detail: "d",
  ...extra,
});

describe("parseDiagnosticsArgs (#491)", () => {
  it("defaults to every section with no flags", () => {
    expect(parseDiagnosticsArgs([])).toEqual({
      ok: true,
      options: {
        quick: false,
        json: false,
        help: false,
        sections: [...DIAGNOSTIC_SECTIONS],
      },
    });
  });

  it("parses --quick, --json and --help / -h", () => {
    const r = parseDiagnosticsArgs(["--quick", "--json", "-h"]);
    expect(r).toMatchObject({
      ok: true,
      options: { quick: true, json: true, help: true },
    });
    expect(parseDiagnosticsArgs(["--help"])).toMatchObject({
      options: { help: true },
    });
  });

  it("accepts --only in both spellings, deduplicated in canonical order", () => {
    const a = parseDiagnosticsArgs(["--only=db,env,db"]);
    const b = parseDiagnosticsArgs(["--only", "db, env"]);
    expect(a).toMatchObject({ ok: true, options: { sections: ["env", "db"] } });
    expect(b).toEqual(a);
  });

  it("rejects an unknown section, a missing --only value, and unknown flags", () => {
    expect(parseDiagnosticsArgs(["--only=nope"])).toEqual({
      ok: false,
      error: expect.stringContaining("Unknown section(s): nope"),
    });
    expect(parseDiagnosticsArgs(["--only"])).toMatchObject({ ok: false });
    expect(parseDiagnosticsArgs(["--only="])).toMatchObject({ ok: false });
    expect(parseDiagnosticsArgs(["--wat"])).toEqual({
      ok: false,
      error: "Unknown argument: --wat",
    });
  });
});

describe("summary and exit code", () => {
  it("counts each status", () => {
    const s = summarizeChecks([
      check("pass"),
      check("pass"),
      check("fail"),
      check("warn"),
      check("skip"),
    ]);
    expect(s).toEqual({ passed: 2, failed: 1, warned: 1, skipped: 1 });
  });

  it("exits 1 only when a check failed; warnings and skips exit 0", () => {
    expect(
      diagnosticsExitCode(summarizeChecks([check("warn"), check("skip")])),
    ).toBe(0);
    expect(diagnosticsExitCode(summarizeChecks([check("fail")]))).toBe(1);
    expect(diagnosticsExitCode(summarizeChecks([]))).toBe(0);
  });
});

describe("redactSecrets", () => {
  it("masks URL passwords and key=value secrets but keeps hosts", () => {
    expect(redactSecrets("postgresql://app:hunter2@db:5432/x")).toBe(
      "postgresql://app:[REDACTED]@db:5432/x",
    );
    expect(redactSecrets("redis://:pw@h")).toBe("redis://:pw@h");
    expect(redactSecrets("JWT_SECRET=abc123 password: p4ss")).toBe(
      "JWT_SECRET=[REDACTED] password: [REDACTED]",
    );
    expect(redactSecrets("nothing sensitive")).toBe("nothing sensitive");
  });
});

describe("buildJsonReport", () => {
  it("reports ok=false with redacted text when a check fails", () => {
    const report = buildJsonReport(
      [
        check("pass"),
        check("fail", {
          detail: "cannot reach postgres://u:secret@h/db",
          remediation: "set token=abc",
        }),
      ],
      { quick: true, sections: ["db"] },
    );
    expect(report.ok).toBe(false);
    expect(report.quick).toBe(true);
    expect(report.sections).toEqual(["db"]);
    expect(report.summary.failed).toBe(1);
    const failing = report.checks[1];
    expect(failing.detail).toBe("cannot reach postgres://u:[REDACTED]@h/db");
    expect(failing.remediation).toBe("set token=[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("secret@");
  });

  it("reports ok=true for warnings only and omits absent remediation", () => {
    const report = buildJsonReport([check("warn")], {
      quick: false,
      sections: [...DIAGNOSTIC_SECTIONS],
    });
    expect(report.ok).toBe(true);
    expect("remediation" in report.checks[0]).toBe(false);
  });
});
