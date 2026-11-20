# Replay-safe authorization payload fingerprints

> Resolves issue #336.

Signed oracle authorizations (EIP-712 `OraclePayload`, see
[`payload-signing.service.ts`](../src/blockchain/oracle/services/payload-signing.service.ts))
carry a nonce and an expiry, but nothing recorded which signed authorizations
had already been *used*. This slice adds:

| File | Purpose |
| --- | --- |
| [`authorization-fingerprint.ts`](../src/blockchain/oracle/authorization/authorization-fingerprint.ts) | Canonical, versioned replay key for an authorization |
| [`authorization-replay-guard.ts`](../src/blockchain/oracle/authorization/authorization-replay-guard.ts) | Single-use claim / complete / release state machine over a pluggable store |
| [`payload-signing.authorization.ts`](../src/blockchain/oracle/authorization/payload-signing.authorization.ts) | Binds the guard to `PayloadSigningService` (structural port, no format change) |

## What the fingerprint commits to

`sha256(canonicalJson(document))`, where the document is:

```json
{
  "schema": "trellis.oracle.authorization-fingerprint.v1",
  "domain": { "name", "version", "chainId" (decimal string), "verifyingContract" (lowercase) },
  "signer": "<lowercase address>",
  "payloadType": "<trimmed, lowercased — same as the signed value>",
  "payloadHash": "<lowercase 0x bytes32>",
  "nonce": "<canonical unsigned decimal>",
  "expiresAt": <unix seconds>
}
```

- **Domain is included**, so an authorization signed for one chain or
  contract cannot be replayed on another under the same key.
- **The signature is excluded on purpose.** ECDSA signatures are malleable
  (65-byte vs EIP-2098 64-byte encodings, high-s/low-s). A replay key built
  on signature bytes can be bypassed by re-encoding. The spec proves a
  compact re-encoding of a used authorization is refused as `REPLAYED`.
- **Non-canonical numbers are rejected**, not normalized (`"07"` is
  `MALFORMED`), so a client cannot mint two keys for one nonce.
- The `schema` id makes any future format change a new namespace instead of a
  silent collision with v1 keys. The spec pins the exact v1 bytes.

## Claim lifecycle

```
(absent) --claim--> in_flight --complete--> consumed (terminal)
                       |  ^
               release |  | claim (retry, or lease lapsed after a crash)
                       v  |
                     released
```

`claim()` checks things in this order. The order is the security property:

1. **Normalize.** Bad input → `MALFORMED` (not retryable). The store is not touched.
2. **Expiry.** `now >= expiresAt` → `EXPIRED`. `expiresAt - now > maxLifetimeSeconds` → `EXPIRY_TOO_FAR`.
   The second check bounds how long records must be retained.
3. **Signature** (and `payloadHash == hashPayload(data)`). On failure →
   `SIGNATURE_INVALID`, and nothing is recorded, so a forged request can
   never burn a legitimate fingerprint.
4. **Claim** by compare-and-set:
   - `consumed` → `REPLAYED`.
   - live `in_flight` lease → `IN_FLIGHT` (retryable).
   - otherwise `in_flight` with a new lease token and `attempt + 1`.
   - Lost CAS rounds (bounded at 3) → `CONTENTION` (retryable).

| Decision | Retryable | Meaning for the caller |
| --- | --- | --- |
| `accepted` | — | Do the work, then call `complete` or `release` |
| `MALFORMED`, `EXPIRED`, `EXPIRY_TOO_FAR`, `SIGNATURE_INVALID` | no | Fix the request; re-sign if needed |
| `REPLAYED` | no | Already used, or the retry budget (`maxAttempts`) is exhausted |
| `IN_FLIGHT`, `CONTENTION` | yes | Retry the same request later |

## Operational edge cases

- **Transient failure after accept** (RPC timeout, DB outage). Call
  `release(fp, lease, reason)`. The same signed request can then be retried,
  and `lastError` keeps the reason. Retries are capped by `maxAttempts`
  (default 5).
- **Worker crash while `in_flight`.** After `leaseMs` (default 30 s) the
  next claim takes the record over (`attempt` increments). The crashed
  worker's lease token is then stale: its `complete`/`release` throws
  `ReplayLeaseError` and cannot overwrite the new owner. Work done under a
  lease must itself be idempotent (the on-chain nonce provides this for oracle
  submissions), because a slow worker can lose its lease while it is still
  running.
- **Lost acknowledgement.** Calling `complete` again with the same lease is a no-op.
- **Clock skew between instances.** Records are pruned only after
  `expiresAt + retentionGraceSeconds` (default 300 s). Every instance refuses
  expired envelopes before any lookup, so a pruned fingerprint can never be
  accepted again, as long as instance clocks differ by less than the grace.
- **Storage.** `ReplayRecordStore.compareAndSet` must be atomic across
  instances: `INSERT … ON CONFLICT DO NOTHING` for creates and
  `UPDATE … WHERE version = $expected` for updates. `InMemoryReplayRecordStore`
  is only safe for a single process and for tests. Store size is bounded by
  (authorizations per second × `maxLifetimeSeconds + grace`). Run `prune()`
  periodically.

## Contracts and migration

- **The EIP-712 signing format is unchanged.** Existing signatures verify and
  fingerprint exactly as before. The module is additive: no endpoint, entity
  or migration changes.
- Adoption is per call site. Wrap the authorized work in
  `claim` → work → `complete`/`release`. A durable store (TypeORM table with a
  unique `fingerprint` and a `version` column) is a follow-up. It needs no
  format change, because the record shape is already defined by `ReplayRecord`.
- **Rollback.** Remove the guard from the call site. Nothing else depends on
  it, and no persisted data changes. Re-enabling it later starts with an empty
  store. Authorizations used while it was off are protected only by their
  nonce and expiry until they expire.
- **Known pre-existing issue.** `payload-signing.service.ts` imports
  `common/serialization/canonical-payload`, which does not exist on `main`, so
  the service cannot currently load. The binding therefore uses a structural
  `OracleSigningPort`, and the spec signs with the identical domain and types.
  Restoring that module is out of scope: it would change how signed data is
  serialized.

## Verification

```sh
npx jest src/blockchain/oracle/authorization
```
