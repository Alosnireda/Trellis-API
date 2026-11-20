/**
 * Pure helpers behind the contributor diagnostics CLI flags (#491):
 * argument parsing, section selection, summary/exit-code rules, and the
 * machine-readable JSON report. No I/O, so every path is unit-testable.
 */

import { CheckStatus, DiagnosticCheck } from "./diagnostics-checks";

export const DIAGNOSTIC_SECTIONS = [
  "tools",
  "deps",
  "env",
  "db",
  "redis",
  "stellar",
  "smtp",
  "build",
  "tests",
] as const;
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];

export interface DiagnosticsOptions {
  quick: boolean;
  json: boolean;
  help: boolean;
  sections: DiagnosticSection[];
}

export type ParsedArgs =
  { ok: true; options: DiagnosticsOptions } | { ok: false; error: string };

export function parseDiagnosticsArgs(argv: string[]): ParsedArgs {
  const options: DiagnosticsOptions = {
    quick: false,
    json: false,
    help: false,
    sections: [...DIAGNOSTIC_SECTIONS],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quick") options.quick = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only" || arg.startsWith("--only=")) {
      const value = arg === "--only" ? argv[++i] : arg.slice("--only=".length);
      if (!value)
        return {
          ok: false,
          error: "--only needs a comma-separated list of sections",
        };
      const requested = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const unknown = requested.filter(
        (s) => !(DIAGNOSTIC_SECTIONS as readonly string[]).includes(s),
      );
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `Unknown section(s): ${unknown.join(", ")}. Valid: ${DIAGNOSTIC_SECTIONS.join(", ")}`,
        };
      }
      // Keep canonical order and drop duplicates so output is deterministic.
      options.sections = DIAGNOSTIC_SECTIONS.filter((s) =>
        (requested as string[]).includes(s),
      );
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }
  return { ok: true, options };
}

export const DIAGNOSTICS_USAGE = `Usage: npm run diagnostics -- [options]

Options:
  --quick            skip slow network, build, audit, and test checks
  --json             print a machine-readable report on stdout
  --only <a,b>       run only these sections (${DIAGNOSTIC_SECTIONS.join(", ")})
  -h, --help         show this help

Exit codes: 0 ok or warnings only, 1 a check failed, 2 bad arguments or script error.`;

export interface DiagnosticsSummary {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
}

export function summarizeChecks(checks: DiagnosticCheck[]): DiagnosticsSummary {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return {
    passed: count("pass"),
    failed: count("fail"),
    warned: count("warn"),
    skipped: count("skip"),
  };
}

/** Warnings never block; only failures do. */
export function diagnosticsExitCode(summary: DiagnosticsSummary): 0 | 1 {
  return summary.failed > 0 ? 1 : 0;
}

/** Masks credentials embedded in connection URLs and `password=` style text. */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?:password|secret|token|apikey|api_key)\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]",
    );
}

export interface DiagnosticsJsonReport {
  ok: boolean;
  quick: boolean;
  sections: DiagnosticSection[];
  summary: DiagnosticsSummary;
  checks: DiagnosticCheck[];
}

export function buildJsonReport(
  checks: DiagnosticCheck[],
  options: Pick<DiagnosticsOptions, "quick" | "sections">,
): DiagnosticsJsonReport {
  const summary = summarizeChecks(checks);
  return {
    ok: diagnosticsExitCode(summary) === 0,
    quick: options.quick,
    sections: options.sections,
    summary,
    checks: checks.map((c) => ({
      ...c,
      detail: redactSecrets(c.detail),
      ...(c.remediation ? { remediation: redactSecrets(c.remediation) } : {}),
    })),
  };
}
