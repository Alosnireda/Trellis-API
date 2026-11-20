# Treasury balance conservation invariants

> Resolves issue #335.

The oracle contract holds submitter stake. It publishes `staked`, `slashed`,
`unbond` and `withdrawn` events (schemas in
[`oracle-contract-events.ts`](../src/blockchain/oracle/events/oracle-contract-events.ts)).
[`OracleStakeTreasuryLedger`](../src/blockchain/oracle/treasury/oracle-stake-treasury.ledger.ts)
folds those decoded events into per-submitter balances. The invariant suite
[`oracle-stake-treasury.invariants.spec.ts`](../src/blockchain/oracle/treasury/oracle-stake-treasury.invariants.spec.ts)
shows that value is never created or lost.

## Invariants

Checked after **every** step by `checkInvariants()`, which re-derives totals
from the accounts on its own rather than trusting the running aggregates:

1. **Conservation:** `deposited = Σ bonded + Σ unbonding + treasury + withdrawn`.
   `treasury` holds the slashed penalties the contract keeps.
2. **Nonnegativity:** no account balance or aggregate is ever negative.
3. **Aggregate agreement:** the running `bonded` and `unbonding` totals equal
   the sum over accounts.
4. **Agreement with the contract:** `staked.total_stake` and
   `slashed.remaining_stake` must equal the projected post-event bonded stake.

## Event semantics

| Event | Effect | Refused when |
| --- | --- | --- |
| `staked(amount, total_stake)` | `bonded += amount`, `deposited += amount` | amount ≤ 0, or `total_stake` ≠ new bonded |
| `slashed(penalty_amount, remaining_stake)` | `bonded -= penalty`, `treasury += penalty` | penalty > bonded, or `remaining_stake` ≠ new bonded |
| `unbond(amount)` | `bonded → unbonding` | amount > bonded |
| `withdrawn(amount)` | `unbonding -= amount`, `withdrawn += amount` | amount > unbonding |

Assumption, to confirm against Trellis-contracts `lib.rs`: `total_stake` and
`remaining_stake` are the **submitter's** stake after the event, and slashing
draws only from bonded stake. If the contract also slashes unbonding stake,
these checks fail closed with `REPORTED_BALANCE_MISMATCH` or
`INSUFFICIENT_BONDED` rather than drifting silently.

## Test strategy

- **25 seeded random histories × 120 steps** (mulberry32, as in
  `src/testing/property-test-harness.ts`). Valid events come from an
  independent reference model, with i128-scale amounts mixed in. A failure
  prints `seed=… step=…` so it can be replayed exactly.
- **Failure path.** About 15 % of steps inject an invalid event: overdrawn
  unbond, withdraw or slash; mismatched reported totals; zero or negative
  amounts. The ledger must throw `StakeLedgerError` and its snapshot must be
  unchanged.
- **Retry path.** About 10 % of steps redeliver an earlier event. The ledger
  must return `duplicate` with no change. Reusing an event id with different
  content is `EVENT_ID_CONFLICT`.
- **Recovery path.** The applied history is replayed into a fresh ledger with
  every event delivered twice. The result must equal the original snapshot.
- **Authorization path.** Events from any contract other than the configured
  oracle are `UNAUTHORIZED_EMITTER`. This is defense in depth on top of the
  decoder's own `foreign_contract` filter.
- An end-to-end case decodes a real `staked` XDR event through
  `decodeOracleContractEvent` before folding it.
- Mutation check performed while writing the suite: making slashes not credit
  the treasury fails the conservation invariant on the first seed.

## Operational edge cases and recovery

- **Rejected events are atomic.** A refused event leaves the ledger
  byte-for-byte unchanged, and its id is not burned, so the correct event can
  still be applied.
- **`REPORTED_BALANCE_MISMATCH` means a gap.** The projection missed or
  double-applied history, or the contract changed semantics. Recover by
  rebuilding from the earliest ledger: replay is idempotent, so you can start
  from any point at or before the gap and duplicates are harmless.
- **Event ids** must be stable across RPC providers. Use
  `<txHash>:<operationIndex>:<eventIndex>`.
- **Memory** grows with the number of applied events (one digest per id).
  For long histories, snapshot the balances at a ledger checkpoint and replay
  from that checkpoint.

## Contracts and migration

The slice is additive and in-memory: no endpoint, entity, migration or
decoder change. **Rollback:** delete the `treasury/` directory. Nothing
depends on it.

## Verification

```sh
npx jest src/blockchain/oracle/treasury
```
