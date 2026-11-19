/**
 * Deterministic Rollback Tests for Failed External Side Effects (#422)
 *
 * Exercises failure, retry, rollback, and compensating saga paths
 * when interacting with external distributed systems (Stellar Horizon / Soroban RPC,
 * payment gateways, and external webhooks).
 *
 * Verifies that:
 * 1. An on-chain rejection (e.g. op_underfunded, tx_bad_seq, Soroban contract panic)
 *    deterministically rolls back local reservations and leaves 0 side effects in the ledger.
 * 2. An uncertain external outcome (e.g. 504 Gateway Timeout, network drop) transitions
 *    into UNCERTAIN_RECONCILIATION_REQUIRED rather than blindly retrying or prematurely rolling back.
 * 3. Multi-phase external side effects execute deterministic compensating actions (Saga rollback).
 * 4. Idempotent retries never produce duplicate external side effects.
 * 5. Authorization rejections occur before any external side effects are dispatched.
 *
 * Uses the deterministic FaultController, SideEffectLedger, and ManualClock harness.
 */

import {
  FaultController,
  SideEffectLedger,
  ManualClock,
  FaultKind,
  SideEffectKind,
} from "../src/testing/fault-injection/fault-injection";

// Domain Types for the Rollback Workflow Under Test
enum ReservationState {
  PENDING = "PENDING",
  RESERVED = "RESERVED",
  SUBMITTING = "SUBMITTING",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
  ROLLED_BACK = "ROLLED_BACK",
  UNCERTAIN_RECONCILIATION_REQUIRED = "UNCERTAIN_RECONCILIATION_REQUIRED",
}

interface LocalAccountState {
  accountId: string;
  balanceXLM: number;
  reservedXLM: number;
}

interface StellarTransactionIntent {
  intentId: string;
  sourceAccount: string;
  destinationAccount: string;
  amountXLM: number;
  sequenceNumber: number;
  state: ReservationState;
  transactionHash?: string;
  errorMessage?: string;
  compensationReceipt?: string;
}

/**
 * Service orchestrating dual-write operations between local balance ledger
 * and the external Stellar Horizon / Soroban network.
 */
class StellarPaymentOrchestrator {
  constructor(
    private readonly faultController: FaultController,
    private readonly ledger: SideEffectLedger,
    private readonly clock: ManualClock,
    private readonly accounts: Map<string, LocalAccountState>,
    private readonly intents: Map<string, StellarTransactionIntent>,
  ) {}

  /**
   * Step 1: Reserve local funds before attempting external side effect.
   */
  async createIntent(
    intentId: string,
    sourceAccount: string,
    destinationAccount: string,
    amountXLM: number,
    actorRole: string,
  ): Promise<StellarTransactionIntent> {
    // Authorization check
    if (actorRole !== "ADMIN" && actorRole !== "OPERATOR") {
      throw new Error("Unauthorized: Actor lacks required role for treasury transfers");
    }

    const account = this.accounts.get(sourceAccount);
    if (!account) throw new Error(`Account ${sourceAccount} not found`);

    const available = account.balanceXLM - account.reservedXLM;
    if (available < amountXLM) {
      throw new Error(`Insufficient funds: available ${available} < requested ${amountXLM}`);
    }

    // Lock reservation
    account.reservedXLM += amountXLM;

    const intent: StellarTransactionIntent = {
      intentId,
      sourceAccount,
      destinationAccount,
      amountXLM,
      sequenceNumber: 100,
      state: ReservationState.RESERVED,
    };
    this.intents.set(intentId, intent);
    return intent;
  }

  /**
   * Step 2: Submit to external Stellar Horizon / Soroban network with deterministic rollback.
   */
  async submitToStellarWithRollback(
    intentId: string,
    maxRetries = 3,
  ): Promise<{ transactionHash: string; state: ReservationState }> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Intent ${intentId} not found`);

    intent.state = ReservationState.SUBMITTING;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Evaluate simulated external collaborator fault from FaultController
        const fault = this.faultController.consume("submit");
        if (fault) {
          if (fault.kind === "timeout" || fault.kind === "network-unreachable" || fault.kind === "connection-reset") {
            // Transient network failure
            throw new Error(`External network failure: ${fault.kind}`);
          } else if (fault.kind === "execution-reverted" || fault.kind === "insufficient-funds") {
            // Horizon op_underfunded / tx_bad_seq permanent error
            throw new Error("Stellar Horizon Error: op_underfunded (permanent)");
          } else if (fault.kind === "http-status" && fault.status === 504) {
            // 504 Gateway Timeout - uncertain outcome
            throw new Error("504 Gateway Timeout: Outcome uncertain");
          }
        }

        // External side effect commits on-chain
        const txHash = `0x_stellar_tx_${intentId}_seq_${intent.sequenceNumber}`;
        this.ledger.record("on-chain-submit", txHash);

        // Update local state to CONFIRMED and deduct balance
        const account = this.accounts.get(intent.sourceAccount)!;
        account.balanceXLM -= intent.amountXLM;
        account.reservedXLM -= intent.amountXLM;

        intent.state = ReservationState.CONFIRMED;
        intent.transactionHash = txHash;
        return { transactionHash: txHash, state: intent.state };
      } catch (err: any) {
        const message = err.message;

        // Check for uncertain timeout: MUST NOT blindly roll back or retry!
        if (message.includes("504 Gateway Timeout")) {
          intent.state = ReservationState.UNCERTAIN_RECONCILIATION_REQUIRED;
          intent.errorMessage = message;
          // Freeze reservation until manual/Horizon polling reconciliation
          throw err;
        }

        // Check for permanent rejection: execute DETERMINISTIC ROLLBACK
        if (message.includes("op_underfunded") || message.includes("tx_bad_seq")) {
          this.executeDeterministicRollback(intent, message);
          throw err;
        }

        // Retryable failure: check attempt count
        if (attempt >= maxRetries) {
          // Max retries exhausted: execute DETERMINISTIC ROLLBACK
          this.executeDeterministicRollback(intent, `Exceeded max retries (${maxRetries}): ${message}`);
          throw err;
        }

        // Retry with backoff
        await this.clock.sleep(50 * 2 ** (attempt - 1));
      }
    }

    throw new Error("Unexpected submission state");
  }

  /**
   * Deterministic rollback procedure: Reverts reservation, updates status,
   * and records compensation receipt.
   */
  private executeDeterministicRollback(
    intent: StellarTransactionIntent,
    reason: string,
  ): void {
    const account = this.accounts.get(intent.sourceAccount);
    if (account) {
      account.reservedXLM = Math.max(0, account.reservedXLM - intent.amountXLM);
    }
    intent.state = ReservationState.ROLLED_BACK;
    intent.errorMessage = reason;
    intent.compensationReceipt = `COMPENSATED_${intent.intentId}_${Date.now()}`;
  }

  /**
   * Multi-Step Saga with External Gateway Compensating Action (e.g. Void/Refund).
   */
  async executeTwoStepSaga(
    sagaId: string,
    amountCents: number,
  ): Promise<{ status: "COMMITTED" | "COMPENSATED" }> {
    // Step 1: External Authorization Side Effect
    const authId = `auth_${sagaId}`;
    this.ledger.record("payment", authId);

    try {
      // Step 2: Secondary side effect (e.g. database settlement)
      const fault = this.faultController.consume("saga-step2");
      if (fault) {
        throw new Error("Secondary settlement failed");
      }
      return { status: "COMMITTED" };
    } catch (error) {
      // Compensating action: Reverse external authorization (Void/Refund)
      const refundId = `refund_for_${authId}`;
      this.ledger.record("payment", refundId);
      return { status: "COMPENSATED" };
    }
  }
}

describe("Deterministic Rollback Tests for Failed External Side Effects (#422)", () => {
  let faultController: FaultController;
  let sideEffectLedger: SideEffectLedger;
  let clock: ManualClock;
  let accounts: Map<string, LocalAccountState>;
  let intents: Map<string, StellarTransactionIntent>;
  let orchestrator: StellarPaymentOrchestrator;

  beforeEach(() => {
    faultController = new FaultController("Stellar Horizon / RPC");
    clock = new ManualClock(0);
    sideEffectLedger = new SideEffectLedger(clock);
    accounts = new Map<string, LocalAccountState>();
    intents = new Map<string, StellarTransactionIntent>();

    // Initial account with 1,000 XLM
    accounts.set("GA_SOURCE_1", {
      accountId: "GA_SOURCE_1",
      balanceXLM: 1000,
      reservedXLM: 0,
    });

    orchestrator = new StellarPaymentOrchestrator(
      faultController,
      sideEffectLedger,
      clock,
      accounts,
      intents,
    );
  });

  describe("Normal Path", () => {
    it("successfully submits transaction on Stellar, commits balance, and records exactly 1 side effect", async () => {
      const intent = await orchestrator.createIntent(
        "tx-norm-1",
        "GA_SOURCE_1",
        "GB_DEST_1",
        200,
        "OPERATOR",
      );

      const result = await orchestrator.submitToStellarWithRollback(intent.intentId);

      expect(result.state).toBe(ReservationState.CONFIRMED);
      expect(result.transactionHash).toMatch(/0x_stellar_tx_tx-norm-1/);

      // Account balance reduced and reservation cleared
      const account = accounts.get("GA_SOURCE_1")!;
      expect(account.balanceXLM).toBe(800);
      expect(account.reservedXLM).toBe(0);

      // Verify side effect ledger
      expect(sideEffectLedger.countOf("on-chain-submit")).toBe(1);
      expect(sideEffectLedger.all()[0].key).toBe(result.transactionHash);
      sideEffectLedger.assertNoDuplicates();
    });
  });

  describe("Deterministic Rollback on On-Chain Reversion", () => {
    it("deterministically rolls back local reservation and records 0 on-chain side effects when Horizon returns op_underfunded", async () => {
      const intent = await orchestrator.createIntent(
        "tx-fail-1",
        "GA_SOURCE_1",
        "GB_DEST_1",
        300,
        "OPERATOR",
      );

      // Inject permanent Stellar failure (insufficient-funds / op_underfunded)
      faultController.queueFault({
        kind: "insufficient-funds",
        message: "Stellar Horizon Error: op_underfunded",
      });

      await expect(
        orchestrator.submitToStellarWithRollback(intent.intentId),
      ).rejects.toThrow("Stellar Horizon Error: op_underfunded (permanent)");

      // Assert Deterministic Rollback State
      expect(intent.state).toBe(ReservationState.ROLLED_BACK);
      expect(intent.compensationReceipt).toBeDefined();

      // Reserved funds are released back to balance
      const account = accounts.get("GA_SOURCE_1")!;
      expect(account.balanceXLM).toBe(1000);
      expect(account.reservedXLM).toBe(0);

      // Crucial invariant: 0 external side effects recorded in ledger
      expect(sideEffectLedger.countOf("on-chain-submit")).toBe(0);
      sideEffectLedger.assertNoDuplicates();
    });
  });

  describe("Uncertain Outcome Handling (504 Timeout / Network Drop)", () => {
    it("enters UNCERTAIN_RECONCILIATION_REQUIRED and avoids premature rollback or blind retry on 504 Timeout", async () => {
      const intent = await orchestrator.createIntent(
        "tx-timeout-1",
        "GA_SOURCE_1",
        "GB_DEST_1",
        150,
        "OPERATOR",
      );

      // Inject 504 Gateway Timeout
      faultController.queueHttpStatus(504);

      await expect(
        orchestrator.submitToStellarWithRollback(intent.intentId),
      ).rejects.toThrow("504 Gateway Timeout: Outcome uncertain");

      // Verifies system does NOT blindly rollback or retry
      expect(intent.state).toBe(ReservationState.UNCERTAIN_RECONCILIATION_REQUIRED);

      // Reservation remains locked until Horizon polling reconciliation resolves
      const account = accounts.get("GA_SOURCE_1")!;
      expect(account.reservedXLM).toBe(150);
      expect(account.balanceXLM).toBe(1000);

      // No confirmed on-chain side effect recorded yet
      expect(sideEffectLedger.countOf("on-chain-submit")).toBe(0);
    });
  });

  describe("Multi-Step Saga Compensating Action Rollback", () => {
    it("executes compensating external refund when secondary side effect fails", async () => {
      // Inject failure on secondary step
      faultController.queueFault({
        kind: "connection-reset",
        message: "Downstream commit crashed",
      });

      const result = await orchestrator.executeTwoStepSaga("order-422", 5000);

      expect(result.status).toBe("COMPENSATED");

      // Verify side effect ledger recorded both initial auth and compensating refund
      expect(sideEffectLedger.countOf("payment")).toBe(2);
      expect(sideEffectLedger.all()[0].key).toBe("auth_order-422");
      expect(sideEffectLedger.all()[1].key).toBe("refund_for_auth_order-422");
    });
  });

  describe("Retry Path without Duplicate Side Effects", () => {
    it("retries transient failure and produces exactly one external side effect", async () => {
      const intent = await orchestrator.createIntent(
        "tx-retry-1",
        "GA_SOURCE_1",
        "GB_DEST_1",
        50,
        "OPERATOR",
      );

      // Inject 1 transient timeout, followed by success
      faultController.queueTimeout("Temporary socket timeout", 1);

      const submissionPromise = orchestrator.submitToStellarWithRollback(intent.intentId);

      // Advance simulated clock past first backoff delay (50ms)
      await clock.advance(60);

      const result = await submissionPromise;
      expect(result.state).toBe(ReservationState.CONFIRMED);

      // Invariant: Exactly 1 external side effect recorded, no duplicate payments
      expect(sideEffectLedger.countOf("on-chain-submit")).toBe(1);
      sideEffectLedger.assertNoDuplicates();
    });
  });

  describe("Authorization Gate Prior to Side Effects", () => {
    it("blocks unauthorized callers before any local reservation or external side effect occurs", async () => {
      await expect(
        orchestrator.createIntent(
          "tx-unauth-1",
          "GA_SOURCE_1",
          "GB_DEST_1",
          100,
          "USER", // Unauthorized role
        ),
      ).rejects.toThrow(/Unauthorized/);

      expect(intents.size).toBe(0);
      expect(accounts.get("GA_SOURCE_1")!.reservedXLM).toBe(0);
      expect(sideEffectLedger.all()).toHaveLength(0);
    });
  });
});
