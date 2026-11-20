# Held operations: resumable work across an emergency pause

Issue #338. The pause guard (`PauseControlGuard`) rejects requests for a paused
scope with `503`. `HeldOperationsService`
(`src/infrastructure/pause-control/held-operations.service.ts`) lets a caller
keep such work instead of dropping it, and replay it once the scope is resumed.

```ts
const out = await held.hold({ scope: "payments", operationId, kind: "payments.settle", payload, requestedBy });
if (!out.held) return runNow(); // scope is not paused
// ...later, after PauseControlService.resumePause(...):
const summary = await held.replay("payments", { id: adminId, roles: ["ADMIN"] });
```

## Behaviour

| Path | Result |
| --- | --- |
| Hold while paused | Stored `pending`. Holding the same `operationId` again returns `duplicate: true` and keeps the first payload. |
| Hold while not paused | `{ held: false, reason: "not-paused" }`; nothing is stored, run the operation directly. |
| Replay by a non-ADMIN | `ForbiddenException`; no handler runs. |
| Replay while still paused | `ConflictException`; resume the scope first. |
| Replay | Oldest first; each operation is marked `completed` before the next starts. |
| Handler throws | Stays `pending` (`retry-later`) until `maxAttempts` (3), then `failed` with `lastError`. Others continue. |
| Scope paused again mid-replay | The run stops (`interrupted: true`); the rest stay `pending`. |
| Held longer than `maxAgeMs` (24h) | Marked `expired`, never replayed. |
| Second replay of the same scope at once | `ConflictException` (one replay per scope per process). |

A scope pause (`payments`) and the `all` pause both block replay, matching
`PauseControlService.isOperationPaused`.

## Edge cases and recovery

- **Crash mid-replay:** statuses are written per operation, so rerunning
  `replay` continues with what is still `pending`. A crash between a handler
  finishing and its status write replays that one operation, so handlers must be
  idempotent on `operationId`.
- **Failed operations:** read `lastError`, fix the cause, and re-submit the work
  with a new `operationId`; `failed` and `expired` rows are never retried
  automatically.
- **Backpressure:** at most `maxHeldPerScope` (1000) pending operations per
  scope; further holds get `ConflictException` and clients should retry after
  resume.
- **Durability:** the bundled `InMemoryHeldOperationStore` is for tests and
  single-process use. Provide a durable `HeldOperationStore` before relying on
  holds surviving a restart. No schema or API route changes ship with this
  slice, so existing pause behaviour and contracts are unchanged.
- **Rollback:** stop calling `hold`/`replay`; the guard and pause API behave as
  before.

Verify with `npx jest src/infrastructure/pause-control`.
