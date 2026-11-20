# Capability Tokens for Sensitive Actions (#273)

A capability token is a short-lived, **single-use** proof that the account
holder deliberately asked to perform **one** sensitive action, and, for
resource-bound actions, on **one** resource. A stolen access token or a leaked
API key is not enough on its own to perform a protected action.

| Property | Value |
| --- | --- |
| Lifetime | 300 s by default, adjustable from 30 to 900 s per token |
| Uses | One successful execution. Failed executions do not count. |
| Bound to | user id, action, resource id (for resource-bound actions) |
| Minted by | an interactive session (`traditional`, `oauth`, `wallet`), never an API key |
| Step-up | current TOTP code if the account has verified 2FA |
| Transport | `X-Capability-Token` request header (redacted from logs) |
| Enforcement | `CAPABILITY_TOKENS_ENFORCED`, read on every request |

Code: `src/core/auth/capability/`.

## Protected actions

| Action | Route | Resource binding |
| --- | --- | --- |
| `access.api-key.created` | `POST /auth/api-keys` | none |
| `access.api-key.revoked` | `DELETE /auth/api-keys/:id` | `:id` |

Action names come from the `SensitiveAction` catalogue, so the same name
appears in tokens, logs and the audit trail. `GET /auth/capabilities/actions`
returns the live list.

## Flow

```
POST /auth/capabilities                      DELETE /auth/api-keys/:id
  { action, resourceId?, ttlSeconds?,          X-Capability-Token: cap1....
    stepUpCode? }
        │                                              │
        ▼                                              ▼
     minted ──────────── claim (atomic reserve) ──► reserved
        │                                              │
        │                                   handler ok │ handler throws
        │                                              ▼          ▼
        │                                         consumed     released
        │                                        (terminal)   (usable again)
        ├── POST /auth/capabilities/revoke ──► revoked
        ├── "log out everywhere" / password change ──► session revoked
        └── exp reached ──► expired
```

1. **Mint**: `POST /auth/capabilities` with
   `{"action": "access.api-key.revoked", "resourceId": "<key id>"}`. Accounts
   with 2FA must also send `stepUpCode`. Each TOTP code can mint only one
   token. The response (`Cache-Control: no-store`) contains `token`, `tokenId`,
   `action`, `resourceId`, `issuedAt`, `expiresAt` and `ttlSeconds`.
2. **Use**: send the token as `X-Capability-Token` on the protected route.
3. **Revoke** (optional): `POST /auth/capabilities/revoke` with
   `{"token": "..."}`. Only the owner can revoke a token. Revoking an expired
   token succeeds and does nothing.

### Token format

```
cap1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>
claims = { v, kid, jti, sub, act, res, iat, exp }
```

The HMAC covers a fixed domain label, the prefix and the encoded claims. A
signature made with the same secret for any other purpose (JWTs, receipts)
will therefore never verify as a capability token. `kid` is derived from the
secret, so a key rotation needs no separate key-id setting. Tokens longer than
1024 characters are rejected before any parsing.

## Migration plan (existing contracts)

With `CAPABILITY_TOKENS_ENFORCED` unset or `false` (the default), the API-key
routes behave as they did before this change for every request that does not
send `X-Capability-Token`. No response shape, status code or route changes for
existing clients.

1. **Deploy** with the flag off. New routes `POST /auth/capabilities`,
   `POST /auth/capabilities/revoke` and `GET /auth/capabilities/actions` become
   available.
2. **Adopt**: clients start minting and sending tokens. A token that is sent
   is fully verified and consumed even while the flag is off. Clients find
   integration bugs before enforcement, and early adopters already get the
   protection.
3. **Enforce**: set `CAPABILITY_TOKENS_ENFORCED=true`. No redeploy is needed
   because the flag is read on every request. Requests without a token now
   get `428`.
4. **Rollback**: set the flag back to `false`. This takes effect on the next
   request. Tokens already in flight keep working, because sent tokens are
   always honoured.

There is no database migration. Single-use state is held in Redis or in
memory and expires with each token.

## Responses

The codes reuse the existing error taxonomy, so the frozen error catalogue
does not change. `message` and `recoveryGuidance` say which check failed.

| Situation | Status | `errorCode` | Retry? |
| --- | --- | --- | --- |
| Enforced and no token | 428 | `PRECONDITION_FAILED` | after minting |
| Malformed, bad signature, unknown key | 403 | `FORBIDDEN` | mint a new token |
| Wrong user, action or resource | 403 | `FORBIDDEN` | mint a correct token |
| Presented or minted with API-key auth | 403 | `FORBIDDEN` | use a user session |
| Expired | 403 | `TOKEN_EXPIRED` | mint a new token |
| Issued more than 30 s in the future (clock skew) | 403 | `FORBIDDEN` | check clocks, then mint |
| Owner's sessions revoked after minting | 401 | `SESSION_TERMINATED` | sign in again |
| Explicitly revoked | 409 | `CONFLICT` | no |
| Already used successfully | 409 | `CONFLICT` | no (`retryable: false`) |
| Another request is using it now | 409 | `CONFLICT` | yes (`retryable: true`, `retryAfterSeconds: 1`) |
| Single-use store unreachable | 503 | `SERVICE_UNAVAILABLE` | yes |
| No signing secret configured | 503 | `SERVICE_UNAVAILABLE` | after configuration |
| Mint: 2FA account without `stepUpCode` | 428 | `PRECONDITION_FAILED` | send a code |
| Mint: wrong or replayed `stepUpCode` | 401 | `INVALID_CREDENTIALS` | next code |
| Mint: unknown action, bad binding or bad TTL | 400 | `INVALID_PARAMETER` / `VALIDATION_ERROR` | fix request |

## Retry semantics

The token is **reserved** before the handler runs. What happens next depends
on how the request ends:

- **Success**: the token is marked **consumed**. Any replay gets 409.
- **The handler, or a pipe such as `ParseUUIDPipe`, throws**: the reservation
  is **released** and the original error is returned. The client can retry
  with the *same* token until it expires. This covers transient failures such
  as a 503 from the database.
- **A concurrent duplicate request** (for example a double-click or an eager
  client retry) gets 409 with `retryable: true`. Exactly one request runs.

Protected handlers should therefore be safe to run again after a failure. The
API-key handlers are: a failed create persists nothing, and revoke is
idempotent.

## Operational edge cases and recovery

| Case | Behaviour | Recovery |
| --- | --- | --- |
| Process crashes mid-request | The reservation stays until the token expires (≤ 15 min), so the token cannot be used again. | Mint a new token. Never reusable is the safe outcome. |
| Release fails (store hiccup after a handler error) | Logged as `capability.release-failed`. The token stays reserved. | Mint a new token. |
| Commit fails after success | Logged as `capability.commit-failed`. The reservation still blocks reuse until the token expires. | None needed. |
| Redis outage | Claims and step-up checks fail **closed** with 503. Unlike the jti blacklist, there is **no** in-memory fallback, because it would allow one use per replica. | Restore Redis. To unblock users urgently, turn the flag off (requests without a token then proceed as before). |
| No Redis configured (`REDIS_URL` unset) | An in-memory store is used and a warning is logged at boot. Correct only for **one** replica. | Configure `REDIS_URL` before scaling out. |
| User clicks "log out everywhere" or changes their password | Every outstanding capability token minted at or before the cutoff is rejected, using the same subject cutoff as access tokens (#369). | Sign in and mint again. |
| Suspected token leak | `POST /auth/capabilities/revoke`, or revoke the user's sessions. | The token dies within ≤ 15 min regardless. |
| Clock skew between replicas | `iat` up to 30 s in the future is tolerated. Expiry uses the verifying replica's clock. | Keep NTP in sync. |
| `CAPABILITY_TOKEN_SECRET` and `JWT_SECRET` both unset | Minting and verification fail closed (503) and an error is logged at boot. | Set a secret. |

### Key rotation and rollback

1. Set `CAPABILITY_TOKEN_PREVIOUS_SECRET` to the current secret and
   `CAPABILITY_TOKEN_SECRET` to a new random value (at least 32 bytes). New
   tokens are signed with the new key, and both keys verify.
2. After at least 15 minutes (the maximum lifetime), remove
   `CAPABILITY_TOKEN_PREVIOUS_SECRET`.
3. **To roll back a rotation**, swap the two values. Tokens from either key
   keep verifying throughout.
4. **Emergency invalidation of every outstanding token**: replace
   `CAPABILITY_TOKEN_SECRET` and leave `*_PREVIOUS_SECRET` unset. Every
   outstanding token is then rejected as an unknown key.

When neither explicit secret is set, the key is derived from `JWT_SECRET`
using HMAC with a fixed label. The raw JWT secret never signs capability
tokens. Switching from the derived key to an explicit secret invalidates
tokens already in flight. They live at most 15 minutes, so clients simply mint
again.

## Observability

The service logs structured events: `capability.minted`, `capability.reserved`,
`capability.consumed`, `capability.released`, `capability.revoked`,
`capability.rejected` (with `reason`), `capability.store-error`,
`capability.release-failed` and `capability.commit-failed`. They carry `jti`,
`sub`, `act` and `res`, **never** the token. `X-Capability-Token`, and the
`capabilityToken`, `stepUpCode` and `token` fields, are redacted by
`src/logging/sanitize.util.ts`.

## Adding a protected action

1. Add the action to `CapabilityAction` and `CAPABILITY_ACTION_POLICIES` in
   `capability-token.types.ts`, with `resourceBound` set. The value must
   already exist in `SensitiveAction`, which a spec asserts.
2. Decorate the route:
   ```ts
   @Delete(":id")
   @RequireCapabilityToken(CapabilityAction.API_KEY_REVOKE, { resourceParam: "id" })
   ```
3. For non-HTTP callers, such as a queue consumer acting on a user's behalf,
   wrap the operation in `CapabilityTokenService.execute(token, requirement, fn)`.
   It gives the same claim, commit and release semantics.

## Tests

| Spec | Covers |
| --- | --- |
| `capability-token.codec.spec.ts` | Round trip, tampering, wrong secret under the same `kid`, rotation, malformed and oversized input, catalogue alignment, flag parsing |
| `capability-token.store.spec.ts` | Reserve, release, consume and revoke semantics, TTL expiry, Redis `SET NX` and guarded release, backend errors propagate |
| `capability-token.service.spec.ts` | Mint (binding, TTL bounds, API-key refusal, TOTP step-up and replay), claim (normal, replay, retry, concurrency, subject/action/resource mismatch, expiry, clock skew, session revocation, store outage, key rotation), revoke, `execute`, secret derivation |
| `capability-token.e2e.spec.ts` | Real `ApiKeysController` over HTTP: flag off keeps the existing contract, flag on returns 428, single use, retry after a 503, release on a pipe failure, cross-user, cross-resource, cross-action and API-key refusals, revocation |
| `src/logging/sanitize.util.spec.ts` | Header and field redaction |

```bash
npx jest src/core/auth/capability src/logging/sanitize.util.spec.ts
```
