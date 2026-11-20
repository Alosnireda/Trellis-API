# Bounded event pagination for high-volume histories

> Resolves issue #334.

`oracle_submission_history` stores every oracle submission as a permanent
replay key. Its rows are never pruned (see `SubmissionHistoryService`), so it
grows without bound. The existing `GET /oracle/submissions?limit&offset` uses
`OFFSET`, which has two problems:

- **Cost.** Postgres reads and discards `offset` rows, so deep pages get slower
  as history grows.
- **Correctness.** A row inserted between two requests shifts every later
  page, so clients see duplicates. A row that is removed causes skipped rows.

## New endpoint

`GET /oracle/submissions/page` requires the `oracle:verify` permission, the
same as the offset endpoint.

| Query | Default | Bounds |
| --- | --- | --- |
| `limit` | 50 | 1–100, otherwise 400 |
| `cursor` | — | Opaque `nextCursor` from the previous page. At most 512 chars; a malformed or non-canonical cursor gets 400 |
| `status` | — | `pending` \| `verified` \| `rejected` |
| `submitter` | — | Stellar `G…`/`C…` address |

```json
{ "items": [ /* SubmissionHistory */ ], "nextCursor": "eyJ2IjoxLC…", "hasMore": true, "limit": 50 }
```

`nextCursor` is `null` on the last page. Cursors use the shared versioned
format from `CursorPaginationService` (`{v, createdAt, id}`, base64url).

## Why it is bounded

- **Fixed work per page.** Each page is a single range scan of `limit + 1`
  rows over `IDX_oracle_history_keyset`. The new migration
  `1792346400000-add-oracle-history-keyset-index` adds it, and the Postgres
  spec asserts the planner uses it. Cost does not depend on how deep the page is.
- **Bounded input.** `limit` is capped at 100 and cursors at 512 chars. Input
  is validated before any query runs.

## Edge cases

- **Microsecond collisions (the subtle one).** `createdAt` is a Postgres
  `timestamp` with microsecond precision, but a cursor carries a JS `Date`,
  which only has milliseconds. A raw `(createdAt, id) < cursor` comparison
  therefore *skips* rows that share the cursor's millisecond and have a later
  microsecond. Ordering and comparison here use
  `date_trunc('milliseconds', "createdAt")`, and the index is built on that
  same expression. The Postgres spec reproduces the bug: with the raw column
  the test fails, and with the fix it passes.
  - The existing `applyDescendingKeyset` callers (audit log, agent reviews)
    have the same latent issue. They are left unchanged to keep this slice
    focused; they need the same fix as a follow-up.
- **Concurrent inserts while paging.** New rows sort before the cursor, so
  they never appear mid-traversal and never shift later pages. Fetch from page
  1 again to see them.
- **Retries.** Cursors are stateless. Repeating a request with the same cursor
  returns the same page (as long as no rows were deleted), so a client can
  retry safely after a timeout.
- **Filter changes between pages.** A cursor is a position, not a query
  snapshot. Reusing it with different filters is allowed and still bounded,
  but clients should keep filters constant for a traversal.

## Contracts and migration

- **The offset endpoint is unchanged.** `GET /oracle/submissions` keeps the
  same parameters, validation and response array. It is marked deprecated in
  code. Clients migrate by switching to `/page` and following `nextCursor`.
- **Migration.** One additive index: `CREATE INDEX IF NOT EXISTS`, idempotent.
  On a very large table, build it ahead of the deploy without blocking writes:

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_oracle_history_keyset"
    ON "oracle_submission_history" ((date_trunc('milliseconds', "createdAt")) DESC, "id" DESC);
  ```

  After that, the migration is a no-op.
- **Rollback.** `npm run migration:revert` drops the index
  (`DROP INDEX IF EXISTS`, idempotent). Reverting the code removes `/page`.
  No data changes in either direction. If the index is missing, `/page` still
  returns correct results, just more slowly.

## Verification

```sh
# Unit: query shape, bounds, cursor handling, authorization, offset contract
npx jest src/blockchain/oracle/services/submission-history src/blockchain/oracle/submission-history.controller.spec.ts

# Real Postgres (opt-in; uses a throwaway schema)
ORACLE_HISTORY_PG_URL=postgres://localhost:5432/postgres \
  npx jest src/blockchain/oracle/services/submission-history.pagination.pg.spec.ts
```
