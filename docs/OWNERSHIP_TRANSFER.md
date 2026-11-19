# Ownership Transfer with Expiry and Audit History

## Overview

`OwnershipTransferModule` (`src/core/ownership/`) implements a two-step, auditable ownership transfer workflow for sensitive resources (`portfolio`, `wallet`, `organization`, `apiKey`). A transfer is initiated by the current owner with an explicit expiration window (default: 72 hours) and only completes when the proposed owner explicitly accepts before expiry.

## Lifecycle & State Machine

- `PENDING` -> `ACCEPTED` (proposed owner calls `POST /ownership/transfers/:id/accept` before `expiresAt`)
- `PENDING` -> `CANCELLED` (current owner calls `DELETE /ownership/transfers/:id`)
- `PENDING` -> `REJECTED` (proposed owner calls `POST /ownership/transfers/:id/reject`)
- `PENDING` -> `EXPIRED` (lazy resolution on `getTransfer` / `acceptTransfer` / `listTransfers`, or batch sweep via `expirePendingTransfers()`)

Every state transition, idempotent retry (`RETRIED_NOOP`), and unauthorized access attempt (`ACCESS_DENIED`) appends an immutable `OwnershipTransferAuditEvent` record queryable via `GET /ownership/transfers/:id/history`.

## Acceptance Path Coverage

- **Normal path**: Current owner initiates transfer -> proposed owner accepts before `expiresAt` -> status becomes `ACCEPTED` with `acceptedAt` timestamp and `INITIATED` + `ACCEPTED` audit events.
- **Failure path**: Self-transfer (`BadRequestException`), duplicate active pending transfer (`ConflictException`), expired acceptance (`BadRequestException` + `EXPIRED` transition), and terminal-state transitions (`BadRequestException`).
- **Retry / Idempotency path**: Passing `idempotencyKey` on `initiateTransfer` returns the existing transfer and logs `RETRIED_NOOP` when parameters match; reusing the same key with different parameters raises `ConflictException`. `expirePendingTransfers()` is safe to run repeatedly.
- **Authorization path**: Only `proposedOwnerId` may accept or reject; only `currentOwnerId` may cancel; only `currentOwnerId` or `proposedOwnerId` may read `GET /ownership/transfers/:id` or `GET /ownership/transfers/:id/history` (all other actors receive `ForbiddenException` and an `ACCESS_DENIED` audit entry).

## Edge Cases & Recovery / Rollback Behavior

1. **Expired Transfer Re-Initiation**: Once a `PENDING` transfer passes `expiresAt`, `findPendingByResource` + `isExpired` allows the owner to initiate a fresh transfer without manual cleanup.
2. **Stuck Pending Transfers**: Run `OwnershipTransferService.expirePendingTransfers()` to sweep stale `PENDING` records to `EXPIRED`.
3. **Rollback**: Because ownership transfer is a two-step state machine, a `PENDING` transfer can be rolled back at zero risk by the current owner via `cancelTransfer`. If an `ACCEPTED` transfer was executed in error, initiate a reverse transfer from the new owner back to the original owner; the full chain remains preserved in `ownership_transfer_audit_events`.

## Migration & Contract Compatibility

- Existing `OwnershipTransfer` endpoints and `getTransfer(id)` signature remain backward-compatible (`actorId` is optional in the service method and populated from `req.user` in the controller).
- Database migration adds nullable `idempotencyKey` column on `ownership_transfers` and creates `ownership_transfer_audit_events` indexed by `(transferId, occurredAt)`.
