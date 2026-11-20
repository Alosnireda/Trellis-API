#!/usr/bin/env ts-node
/**
 * Oracle contract upgrade compatibility snapshot check (Issue #333)
 *
 * Usage:
 *   npm run contract:snapshot:check
 *   npm run contract:snapshot:check -- --json
 *   npm run contract:snapshot:update -- --actor-role maintainer
 *   npm run contract:snapshot:update -- --actor-role maintainer --allow-breaking --reason "coordinated v3 release"
 */

import { runSnapshotCli } from "../src/blockchain/oracle/compatibility/oracle-contract-snapshot.cli";

process.exitCode = runSnapshotCli(process.argv.slice(2), {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  env: process.env,
});
