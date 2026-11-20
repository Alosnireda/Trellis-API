# Property-Based Testing for Financial and Ownership Invariants

This document outlines the property-based testing framework and mathematical invariants implemented for Trellis API.

## Harness Architecture

The property testing suite (`src/testing/property-test-harness.ts`) is a lightweight, zero-dependency engine designed for deterministic, reproducible property verification.

### Key Components

1. **Mulberry32 Deterministic PRNG**:
   - Generates deterministic pseudo-random sequences given a 32-bit integer seed.
   - Every run outputs the exact seed used. A failing property can be reproduced deterministically by re-running with `{ seed: <failing_seed> }`.

2. **Primitive & Domain Generators (`Gen`)**:
   - `Gen.integer(min, max)`: Uniform integer generation with bisect shrinking.
   - `Gen.float(min, max, precision)`: Decimal float values with rounding.
   - `Gen.portfolioWeights(numAssets)`: Generates asset allocations guaranteed to sum to $100\%$ with zero drift.
   - `Gen.stroopAmount(maxInXlm)`: 7-decimal Stroop values ($1\text{ XLM} = 10,000,000\text{ stroops}$).
   - `Gen.array()`, `Gen.record()`, `Gen.oneOf()`, `Gen.string()`.

3. **Shrinking**:
   - Upon encountering an invariant violation, generators shrink the failing input toward minimal edge cases (e.g., zero, bounds, empty arrays) to simplify root-cause triage.

---

## Domain Invariants Covered

### 1. Financial Invariants (`test/property/financial-invariants.property.spec.ts`)

| Invariant | Description | Path Covered |
| :--- | :--- | :--- |
| **Non-Negative Balance** | $\text{balance} \ge 0$ for all valid deposit and withdrawal permutations. Withdrawals exceeding balance are rejected. | Normal & Failure |
| **Conservation of Value** | Total system value $\sum V_i$ before an atomic multi-party rebalance or transfer equals $\sum V_i$ after. Rollback preserves exact initial balances. | Normal & Rollback |
| **Portfolio Weight Sum** | Allocation weights $w_i \in [0, 100]$ must satisfy $\sum_{i=1}^n w_i = 100\%$. Deviations or negative weights are rejected. | Normal & Failure |
| **Idempotency & Double Spend** | Duplicate submissions carrying identical idempotency keys return existing state without duplicate mutation. | Retry |
| **Role Authorization** | Unprivileged actors (e.g. `USER`) cannot execute `PAYMENT_PROCESS` or administrative withdrawals. | Authorization |
| **Precision Bounds** | 7-decimal stroop math never yields `NaN`, `Infinity`, or negative values. | Boundary / Edge Case |

### 2. Ownership Invariants (`test/property/ownership-invariants.property.spec.ts`)

| Invariant | Description | Path Covered |
| :--- | :--- | :--- |
| **Single Owner** | At any timestamp $t$, exactly one active owner exists per resource. | Normal |
| **No Self-Transfer** | A transfer where $\text{currentOwner} = \text{proposedOwner}$ is immediately rejected. | Failure |
| **Transfer Authorization** | Only current owner can initiate transfer; only proposed owner can accept. Third parties are rejected. | Authorization |
| **Expiry Monotonicity** | When $\text{currentTime} \ge \text{expiresAt}$, acceptance fails and transfer status moves to `EXPIRED`. | Failure / Lifecycle |
| **Atomic Rollback** | Mid-flight failure during ownership transfer commit restores the prior owner completely. | Rollback |
| **Idempotency** | Re-submitting transfer initiation with the same idempotency key returns the original transfer ID. | Retry |

---

## Verification & Execution

Run property test suites via Jest:

```bash
npx jest test/property/financial-invariants.property.spec.ts
npx jest test/property/ownership-invariants.property.spec.ts
```

All suites execute 50–100 iterations per property using deterministic seeds.

## Preserving Existing Contracts

The property testing harness and specs are purely additive and require no changes to existing entities, database tables, or HTTP APIs.
