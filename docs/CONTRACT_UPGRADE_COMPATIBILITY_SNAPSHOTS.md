# Deterministic contract upgrade compatibility snapshots

> Resolves issue #333.

The API is coupled to the deployed oracle contract in four ways. Before this
change, those couplings were spread across
`stellar-oracle.adapter.ts` and `oracle-contract-events.ts`:

| Coupling | Source | Snapshot path |
| --- | --- | --- |
| Invocation ABI `verify()` accepts | `SUBMIT_PRICE_FUNCTION`, `SUBMIT_PRICE_ARGUMENT_TYPES` | `functions.submit_price.args` |
| Storage keys read by `getOracleLedgerState()` | `FEED_HISTORY_KEY` | `storage.feedHistory` |
| Event schemas decoded | `ORACLE_CONTRACT_EVENT_SCHEMAS`, `ORACLE_EVENT_NAMESPACE` | `events.*` |
| Decoder hard limits | `MAX_ORACLE_EVENT_DATA_FIELDS`, `MAX_CONTRACT_EVENTS_PER_TRANSACTION` | `limits.*` |

[`oracle-contract-snapshot.ts`](../src/blockchain/oracle/compatibility/oracle-contract-snapshot.ts)
collects all of them into one snapshot, versioned as
`trellis.oracle.contract-compat-snapshot.v1`. The committed baseline is
[`__snapshots__/oracle-contract.snapshot.json`](../src/blockchain/oracle/compatibility/__snapshots__/oracle-contract.snapshot.json).

## Determinism

- The snapshot is built from the live constants and round-tripped through
  `canonicalJson`. Keys are sorted, and event versions are ordered by version
  number regardless of the order they appear in the source.
- The file is `{ digest, snapshot }`, where `digest = sha256(canonicalJson(snapshot))`.
  It is written with a 2-space indent and a trailing newline, so rebuilding
  always produces identical bytes and a diff shows only real changes.
- The spec rebuilds the snapshot from reversed source order and asserts the
  output bytes are identical.

## Change classification

`compareOracleContractSnapshots(baseline, candidate)` returns a sorted,
deterministic list of changes:

| Change | Severity | Why |
| --- | --- | --- |
| New event kind, new function, new storage key | additive | Ignored or unused until code opts in |
| New event version that **appends** to the previous version | additive | Matches the decoder's append-only rule (#348) |
| Raised limit | additive | Accepts a superset |
| Removed kind, version, function or storage key | **breaking** | Emitted history or calls become unreadable |
| Retyped, reordered or removed event fields; non-appending new version | **breaking** | Already-emitted events stop decoding |
| Any `submit_price` argument change | **breaking** | `verify()` matches arity and types exactly |
| Lowered limit, namespace change, snapshot schema change | **breaking** | Previously accepted data is refused |

## Workflow

```sh
npm run contract:snapshot:check            # exit 0 = matches, 1 = drift, 2 = missing/corrupt baseline
npm run contract:snapshot:check -- --json  # machine-readable report for CI
```

The spec also compares the committed baseline with the code. Any change to
the constants above therefore fails `npm test` until the baseline is updated
on purpose:

```sh
# Additive change (e.g. registered a v2 that appends a field)
npm run contract:snapshot:update -- --actor-role maintainer

# Breaking change: only after the coordinated-release steps in
# docs/oracle-contract-event-compatibility.md (deploy the API before the contract)
npm run contract:snapshot:update -- --actor-role maintainer \
  --allow-breaking --reason "Coordinated oracle v3 release, see #NNN"
```

## Authorization

Updating the baseline is how a contract upgrade gets accepted, so it is gated
the same way as event-schema baselines (`event-schema-drift.service.ts`):

- The role must be `admin`, `maintainer` or `platform-engineer`. It comes from
  `--actor-role` or `SNAPSHOT_ACTOR_ROLE`. An actor id (`USER` or
  `GITHUB_ACTOR`) is required.
- Breaking changes also require `--allow-breaking` **and** a `--reason` of at
  least 10 characters.
- Every successful update prints a JSON audit line with the actor, role,
  reason, old and new digests, and the list of changes. Paste it into the PR.
  The file itself stays deterministic, so the reason is not stored in it.

## Operational edge cases and recovery

- **Interrupted update.** The file is written to a temp file and then renamed
  into place, so it is never left half-written. Rerunning the update is safe:
  if nothing changed it reports `nothing written` and leaves the bytes as they
  are.
- **Hand-edited or corrupt baseline.** The digest check fails (`exit 2`) and
  the check refuses to compare against it. The only way to recover is an
  authorized `--update`, which rebuilds the baseline from code.
- **Contract shipped a breaking release first.** `check` lists the exact
  breaking paths. Follow the runbook in
  `oracle-contract-event-compatibility.md` (register the new version and
  deploy the decoder), then update the baseline with `--allow-breaking`.
- **Rollback.** Reverting the PR restores the earlier baseline together with
  the earlier code, so the two always match.

## Contracts and migration

- No runtime behavior changes. The adapter refactor only exports constants
  that were previously inlined (`SUBMIT_PRICE_FUNCTION`,
  `SUBMIT_PRICE_ARGUMENT_TYPES`, `FEED_HISTORY_KEY`). The adapter specs pass
  unchanged.
- No database, endpoint or event-format changes. New npm scripts:
  `contract:snapshot:check` and `contract:snapshot:update`.

## Verification

```sh
npx jest src/blockchain/oracle/compatibility
npm run contract:snapshot:check
```
