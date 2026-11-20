import { Gen, assertProperty } from "../../src/testing/property-test-harness";
import { Role, Permission, hasPermission } from "../../src/common/guard/roles.enum";

interface FinancialAccount {
  id: string;
  ownerId: string;
  balanceStroops: bigint;
  idempotencyLog: Set<string>;
}

class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantViolationError";
  }
}

class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

class FinancialLedgerSimulator {
  private accounts = new Map<string, FinancialAccount>();

  createAccount(id: string, ownerId: string, initialBalance: bigint = 0n): FinancialAccount {
    const acc: FinancialAccount = {
      id,
      ownerId,
      balanceStroops: initialBalance,
      idempotencyLog: new Set(),
    };
    this.accounts.set(id, acc);
    return acc;
  }

  getAccount(id: string): FinancialAccount | undefined {
    return this.accounts.get(id);
  }

  deposit(accountId: string, amount: bigint, idempotencyKey?: string): bigint {
    if (amount <= 0n) throw new InvariantViolationError("Deposit amount must be strictly positive");
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error("Account not found");

    if (idempotencyKey && acc.idempotencyLog.has(idempotencyKey)) {
      // Idempotent retry: return existing balance without re-applying
      return acc.balanceStroops;
    }

    acc.balanceStroops += amount;
    if (idempotencyKey) acc.idempotencyLog.add(idempotencyKey);
    return acc.balanceStroops;
  }

  withdraw(
    actor: { id: string; roles: Role[] },
    accountId: string,
    amount: bigint,
    idempotencyKey?: string,
  ): bigint {
    if (!hasPermission(actor.roles, Permission.PAYMENT_PROCESS)) {
      throw new UnauthorizedError("Actor lacks PAYMENT_PROCESS permission");
    }
    if (amount <= 0n) throw new InvariantViolationError("Withdrawal amount must be strictly positive");
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error("Account not found");

    if (idempotencyKey && acc.idempotencyLog.has(idempotencyKey)) {
      return acc.balanceStroops;
    }

    if (acc.balanceStroops < amount) {
      throw new InsufficientFundsError(
        `Insufficient funds: balance=${acc.balanceStroops}, requested=${amount}`,
      );
    }

    acc.balanceStroops -= amount;
    if (idempotencyKey) acc.idempotencyLog.add(idempotencyKey);
    return acc.balanceStroops;
  }

  /**
   * Atomic transfer between two accounts with rollback on failure.
   */
  atomicTransfer(
    actor: { id: string; roles: Role[] },
    fromId: string,
    toId: string,
    amount: bigint,
    failDuringTransfer: boolean = false,
  ): void {
    const fromAcc = this.accounts.get(fromId);
    const toAcc = this.accounts.get(toId);
    if (!fromAcc || !toAcc) throw new Error("Accounts not found");

    const fromBefore = fromAcc.balanceStroops;
    const toBefore = toAcc.balanceStroops;

    try {
      this.withdraw(actor, fromId, amount);

      if (failDuringTransfer) {
        throw new Error("Simulated network/ledger failure mid-transfer");
      }

      this.deposit(toId, amount);
    } catch (err) {
      // Rollback to before-image
      fromAcc.balanceStroops = fromBefore;
      toAcc.balanceStroops = toBefore;
      throw err;
    }
  }
}

describe("Property Tests: Financial Invariants", () => {
  const authorizedActor = { id: "operator-1", roles: [Role.OPERATOR] };
  const unauthorizedActor = { id: "user-1", roles: [Role.USER] };

  it("invariant: balance is always non-negative under arbitrary valid deposits and withdrawals", async () => {
    const report = await assertProperty(
      "non-negative balance",
      Gen.array(
        Gen.record({
          type: Gen.oneOf(["deposit", "withdraw"] as const),
          amount: Gen.stroopAmount(500),
        }),
        1,
        20,
      ),
      (ops) => {
        const ledger = new FinancialLedgerSimulator();
        const acc = ledger.createAccount("acc-1", "user-1", 1_000_000_000n); // 100 XLM starting

        for (const op of ops) {
          if (op.type === "deposit") {
            ledger.deposit(acc.id, op.amount);
          } else {
            try {
              ledger.withdraw(authorizedActor, acc.id, op.amount);
            } catch (err) {
              if (!(err instanceof InsufficientFundsError)) throw err;
            }
          }
          // Invariant: Balance must NEVER drop below zero
          expect(acc.balanceStroops >= 0n).toBe(true);
        }
      },
      { iterations: 100, seed: 1001 },
    );

    expect(report.passed).toBe(true);
  });

  it("invariant: conservation of value holds under atomic multi-account transfers", async () => {
    const report = await assertProperty(
      "conservation of value",
      Gen.record({
        initA: Gen.stroopAmount(1000),
        initB: Gen.stroopAmount(1000),
        transferAmount: Gen.stroopAmount(500),
        shouldFail: Gen.boolean(),
      }),
      (scenario) => {
        const ledger = new FinancialLedgerSimulator();
        const accA = ledger.createAccount("acc-a", "alice", scenario.initA);
        const accB = ledger.createAccount("acc-b", "bob", scenario.initB);

        const totalValueBefore = accA.balanceStroops + accB.balanceStroops;

        try {
          ledger.atomicTransfer(
            authorizedActor,
            accA.id,
            accB.id,
            scenario.transferAmount,
            scenario.shouldFail,
          );
        } catch (err) {
          // Failure occurred: verify rollback occurred and total value is preserved
          const totalValueAfterFailure = accA.balanceStroops + accB.balanceStroops;
          expect(totalValueAfterFailure).toBe(totalValueBefore);
          return;
        }

        // Normal success: total value must be exactly conserved
        const totalValueAfterSuccess = accA.balanceStroops + accB.balanceStroops;
        expect(totalValueAfterSuccess).toBe(totalValueBefore);
      },
      { iterations: 100, seed: 2002 },
    );

    expect(report.passed).toBe(true);
  });

  it("invariant: target portfolio rebalancing weights must strictly sum to 100%", async () => {
    const report = await assertProperty(
      "portfolio weights sum invariant",
      Gen.portfolioWeights(4),
      (weights) => {
        const sum = weights.reduce((a, b) => a + b, 0);
        // Invariant: Each weight >= 0 and sum === 100 (within 0.01 tolerance)
        expect(weights.every((w) => w >= 0)).toBe(true);
        expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01);
      },
      { iterations: 100, seed: 3003 },
    );

    expect(report.passed).toBe(true);
  });

  it("retry path: duplicate operations with the same idempotency key are strictly idempotent", async () => {
    const report = await assertProperty(
      "idempotency idempotency-safety",
      Gen.record({
        amount: Gen.stroopAmount(100),
        key: Gen.string(12),
      }),
      (input) => {
        const ledger = new FinancialLedgerSimulator();
        const acc = ledger.createAccount("acc-retry", "alice", 10_000_000_000n);

        const bal1 = ledger.deposit(acc.id, input.amount, input.key);
        // Duplicate submission
        const bal2 = ledger.deposit(acc.id, input.amount, input.key);

        expect(bal1).toBe(bal2);
        expect(acc.balanceStroops).toBe(10_000_000_000n + input.amount);
      },
      { iterations: 50, seed: 4004 },
    );

    expect(report.passed).toBe(true);
  });

  it("authorization path: unprivileged roles cannot execute withdrawals", async () => {
    const report = await assertProperty(
      "unauthorized withdrawal rejection",
      Gen.stroopAmount(100),
      (amount) => {
        const ledger = new FinancialLedgerSimulator();
        const acc = ledger.createAccount("acc-auth", "alice", 1_000_000_000n);

        expect(() =>
          ledger.withdraw(unauthorizedActor, acc.id, amount),
        ).toThrow(UnauthorizedError);

        // Balance untouched
        expect(acc.balanceStroops).toBe(1_000_000_000n);
      },
      { iterations: 50, seed: 5005 },
    );

    expect(report.passed).toBe(true);
  });

  it("precision safety: stroop conversions never produce negative, NaN, or non-finite numbers", async () => {
    const report = await assertProperty(
      "stroop precision math",
      Gen.float(0.0000001, 1_000_000, 7),
      (xlmFloat) => {
        const stroopsPerXlm = 10_000_000;
        const stroops = Math.round(xlmFloat * stroopsPerXlm);
        const reconstructedXlm = stroops / stroopsPerXlm;

        expect(Number.isFinite(stroops)).toBe(true);
        expect(Number.isFinite(reconstructedXlm)).toBe(true);
        expect(stroops).toBeGreaterThanOrEqual(1);
        expect(Math.abs(reconstructedXlm - xlmFloat)).toBeLessThanOrEqual(0.0000001);
      },
      { iterations: 100, seed: 6006 },
    );

    expect(report.passed).toBe(true);
  });
});
