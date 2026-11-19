# Cross-Service Event Schema Drift Detection

## Overview

Cross-service event schema drift detection (`src/common/contract/cross-service/`) protects producers and consumers from unannounced breaking changes to domain event contracts registered in `CROSS_SERVICE_EVENT_DEFINITIONS`.

## Components

- `detectContractDrift` (`cross-service-contract-drift.ts`): Pure, deterministic diff engine comparing a `baseline` snapshot against `current` definitions.
- `EventSchemaDriftService` (`event-schema-drift.service.ts`):
  - **Normal path**: Evaluates baseline vs current definitions (`checkBaselineDrift`) and validates runtime event payloads (`validateEventPayload`). Additive new events and major-bumped breaking changes pass cleanly.
  - **Failure path**: Flags removed events, producer changes, added/removed required fields, payload type changes, removed consumers, version regressions, and unbumped breaking changes; rejects invalid runtime payloads.
  - **Retry path**: `checkBaselineWithRetry` retries transient baseline fetch/I/O failures up to `maxRetries` before failing with attempt diagnostics.
  - **Authorization path**: `assertAuthorizedBaselineMutation` restricts baseline snapshot emission/updates to `admin`, `maintainer`, `platform-engineer`, or actors holding `contracts:write`.
- CLI (`scripts/check-event-schema-drift.ts`): Executable CI/local verification script supporting `--json`, `--baseline <path>`, and `--emit-baseline <path> --actor-role admin`.

## Edge Cases & Recovery / Rollback Behavior

1. **Intentional Breaking Change**: Bump the event's `versioning.schemaVersion` major version (e.g. `1.0.0` -> `2.0.0`) so `detectContractDrift` marks the change as acknowledged rather than blocking CI.
2. **Transient Registry/Disk Error**: `checkBaselineWithRetry` automatically retries transient failures before failing closed (exit code `1`).
3. **Rollback**: If a producer emits a drifted payload or breaking contract change slips through, revert the producer commit or restore the previous baseline snapshot; no destructive database migrations are involved.

## Contract Compatibility

- `detectContractDrift` and `CROSS_SERVICE_EVENT_DEFINITIONS` signatures and return types are preserved unchanged.
