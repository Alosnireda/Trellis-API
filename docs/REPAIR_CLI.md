# Dry-Run Repair Tooling with Checkpoints

`repair-cli` provides an operator-safe command-line repair framework for detecting and healing orphaned or inconsistent records across Trellis API datastores.

## Key Features & Invariants

1. **Dry-Run by Default**: Unless `--apply` is explicitly passed, the tool runs in `--dry-run` mode. It detects and tallies discrepancies without performing any writes or mutating state.
2. **Durable, Resumable Checkpoints**: Progress is tracked using `FileRepairCheckpointStore` in `.repair/<jobId>.json`. Saves are atomic (temp-file write followed by rename), ensuring that mid-batch crashes never corrupt the checkpoint file. Re-executing with the same `--id` seamlessly resumes from the last committed cursor.
3. **Idempotent Repair & Journaling**: Repaired records no longer match `detect()`. For every repaired record, the `before` state is recorded into a journal in the checkpoint.
4. **Deterministic Rollback**: Passing `--rollback` restores journaled before-images in newest-first order, unwinding changes step-by-step and marking the job `rolled_back`.
5. **Authorization Enforcement**: Execution and rollback strictly require `Role.MAINTAINER` and `Permission.SYSTEM_MAINTENANCE`. Unauthorized callers receive `ForbiddenException` before any records are read or modified.

## Command Reference

```bash
# Dry-run preview (scans records, identifies issues, commits no changes)
npm run repair -- --job demo-records

# Apply repairs with explicit run ID
npm run repair -- --job demo-records --id run-20261119 --apply

# Inspect stored checkpoint progress and failures
npm run repair -- --job demo-records --id run-20261119 --report

# Rollback applied changes newest-first from checkpoint journal
npm run repair -- --job demo-records --id run-20261119 --rollback

# Reset checkpoint to start fresh
npm run repair -- --job demo-records --id run-20261119 --restart --force

# List all checkpoints
npm run repair -- --list
```

## Operational Paths & Edge Cases

| Path / Condition | Expected Behavior |
| :--- | :--- |
| **Normal Path** | `--dry-run` counts discrepancies in `detected`; `--apply` fixes records and journals before-images; status ends `completed`. |
| **Failure Path** | Transient repair errors are retried up to `--max-retries` times. Persistent failures are recorded in `failures[]`, and the job continues with remaining records. |
| **Crash Mid-Batch** | Cursor remains at the start of the current batch. On resume, repaired records are skipped by `detect()`, preventing double-repair. |
| **Checkpoint Store Failure** | Job status is marked `failed` and rethrows. Resume re-scans safely. |
| **Interrupted Rollback** | Rollback shrinks the journal as each record is restored. If interrupted, calling `--rollback` again safely resumes unwinding the remaining records. |
| **Concurrent Execution** | Running the same `--id` concurrently in a single process throws `ConflictException`. |

## Migration Plan & Contract Preservation

This tooling is purely additive. It reuses the core `RepairJob<R>` abstraction without altering any existing database schemas, public APIs, or database migrations.
