#!/usr/bin/env ts-node
/**
 * Cross-Service Event Schema Drift Check CLI (Issue #438)
 *
 * Compares a baseline event contract snapshot against `CROSS_SERVICE_EVENT_DEFINITIONS`.
 * When no `--baseline` file is supplied, performs a self-consistency check against
 * the current registry.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/check-event-schema-drift.ts
 *   npx ts-node -r tsconfig-paths/register scripts/check-event-schema-drift.ts --json
 *   npx ts-node -r tsconfig-paths/register scripts/check-event-schema-drift.ts --baseline path/to/baseline.json
 *   npx ts-node -r tsconfig-paths/register scripts/check-event-schema-drift.ts --emit-baseline path/to/baseline.json --actor-role admin
 */

import * as fs from "fs";
import * as path from "path";
import { CROSS_SERVICE_EVENT_DEFINITIONS } from "../src/common/contract/cross-service/cross-service-contract-map.registry";
import { DomainEventContractDefinition } from "../src/common/contract/cross-service/cross-service-contract-map.types";
import { EventSchemaDriftService } from "../src/common/contract/cross-service/event-schema-drift.service";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_USAGE = 2;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json");
  const baselineIdx = args.indexOf("--baseline");
  const emitIdx = args.indexOf("--emit-baseline");
  const roleIdx = args.indexOf("--actor-role");

  const service = new EventSchemaDriftService();

  if (emitIdx !== -1) {
    const outPath = args[emitIdx + 1];
    if (!outPath) {
      console.error("--emit-baseline requires a file path");
      return EXIT_USAGE;
    }
    const role = roleIdx !== -1 ? args[roleIdx + 1] ?? "" : process.env.DRIFT_ACTOR_ROLE ?? "";
    service.assertAuthorizedBaselineMutation({
      actorId: process.env.USER ?? "cli-operator",
      role,
    });
    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(
      resolved,
      JSON.stringify(CROSS_SERVICE_EVENT_DEFINITIONS, null, 2) + "\n",
      "utf8",
    );
    if (!isJson) {
      console.log(`✅ Emitted event schema baseline to ${resolved}`);
    } else {
      console.log(JSON.stringify({ emitted: resolved, count: CROSS_SERVICE_EVENT_DEFINITIONS.length }));
    }
    return EXIT_OK;
  }

  let baseline: DomainEventContractDefinition[] = CROSS_SERVICE_EVENT_DEFINITIONS;
  if (baselineIdx !== -1) {
    const baselinePath = args[baselineIdx + 1];
    if (!baselinePath) {
      console.error("--baseline requires a file path");
      return EXIT_USAGE;
    }
    const resolved = path.resolve(baselinePath);
    baseline = await service.checkBaselineWithRetry(
      async () => JSON.parse(fs.readFileSync(resolved, "utf8")) as DomainEventContractDefinition[],
      { maxRetries: 2 },
    ).then(() => JSON.parse(fs.readFileSync(resolved, "utf8")) as DomainEventContractDefinition[]);
  }

  const report = service.checkBaselineDrift(baseline, CROSS_SERVICE_EVENT_DEFINITIONS);
  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Event Schema Drift Check: ok=${report.ok} breaking=${report.breakingCount} info=${report.informationalCount}`);
    for (const finding of report.findings) {
      console.log(`  [${finding.breaking ? "BREAKING" : "INFO"}] ${finding.eventName} (${finding.kind}): ${finding.detail}`);
    }
  }

  return report.ok ? EXIT_OK : EXIT_DRIFT;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`❌ Event schema drift check failed: ${err.message}`);
    process.exit(EXIT_DRIFT);
  });
