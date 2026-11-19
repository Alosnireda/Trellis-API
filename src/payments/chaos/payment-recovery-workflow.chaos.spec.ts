import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PaymentsService } from "../payments.service";
import { PaymentOperationState } from "../entities/payment-operation.entity";
import type { PaymentOperation } from "../entities/payment-operation.entity";
import { ChaosScenario } from "../../testing/chaos/chaos-scenario";

class MemoryOperationRepository {
  readonly rows: PaymentOperation[] = [];

  create(value: Partial<PaymentOperation>): PaymentOperation {
    const row = {
      createdAt: new Date(),
      updatedAt: new Date(),
      ...value,
    } as PaymentOperation;
    this.rows.push(row);
    return row;
  }

  async findOne(options: { where?: Partial<PaymentOperation> }) {
    const where = options.where ?? {};
    return (
      this.rows.find((row) =>
        Object.entries(where).every(
          ([key, expected]) => (row as Record<string, unknown>)[key] === expected,
        ),
      ) ?? null
    );
  }

  async find() {
    return [...this.rows];
  }

  async save(value: PaymentOperation): Promise<PaymentOperation> {
    const index = this.rows.findIndex(
      (row) => row.operationId === value.operationId,
    );
    const saved = {
      ...value,
      updatedAt: new Date(),
    } as PaymentOperation;
    if (index >= 0) this.rows[index] = saved;
    else this.rows.push(saved);
    return saved;
  }

  async update(
    where: Partial<PaymentOperation>,
    patch: Partial<PaymentOperation>,
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (let index = 0; index < this.rows.length; index += 1) {
      const matches = Object.entries(where).every(
        ([key, expected]) =>
          (this.rows[index] as Record<string, unknown>)[key] === expected,
      );
      if (!matches) continue;
      this.rows[index] = {
        ...this.rows[index],
        ...patch,
        updatedAt: new Date(),
      };
      affected += 1;
    }
    return { affected };
  }
}

describe("payment workflow recovery chaos (#402)", () => {
  function makeScenario() {
    const scenario = new ChaosScenario();
    const repo = new MemoryOperationRepository();
    const processor: any = {
      name: "stellar",
      capabilities: {
        supportsPartialRefund: true,
        requiresClientSideSigning: false,
        currencies: ["XLM"],
      },
      supportsSafeSubmissionRetry: true,
      getStatus: jest.fn(),
      submitTransaction: jest.fn(),
    };
    const factory: any = { resolve: jest.fn().mockReturnValue(processor) };
    const service = new PaymentsService(factory, {} as any, repo as any, null);
    repo.create({
      operationId: "op-1",
      ownerId: "owner-1",
      processorName: "stellar",
      idempotencyKey: "idem-1",
      requestFingerprint: "fingerprint-1",
      state: PaymentOperationState.SIGNED,
      paymentId: "pay-1",
      createdPayment: null,
      signedPayload: "signed-1",
      signerAddress: null,
      transactionHash: null,
      submittedTransaction: null,
      lastError: null,
    });
    return {
      scenario,
      repo,
      processor,
      service,
      signed: { paymentId: "pay-1", signedPayload: "signed-1" } as any,
    };
  }

  it("submits once on the normal path", async () => {
    const { scenario, repo, processor, service, signed } = makeScenario();
    processor.submitTransaction.mockImplementation(async () => {
      scenario.ledger.record("on-chain-submit", "pay-1");
      return { paymentId: "pay-1", transactionHash: "tx-1", status: "CONFIRMED" };
    });

    await expect(service.submitTransaction(signed, "stellar", "owner-1")).resolves.toMatchObject({
      transactionHash: "tx-1",
    });
    expect(repo.rows[0].state).toBe(PaymentOperationState.SUBMITTED);
    expect(scenario.ledger.count("pay-1")).toBe(1);
    scenario.assertClean();
  });

  it("recovers from a kill before the irreversible submit", async () => {
    const { scenario, repo, processor, service, signed } = makeScenario();
    scenario.killPoint.armKill("after-claim-before-submit");
    processor.submitTransaction.mockImplementation(async () => {
      scenario.killPoint.checkpoint("after-claim-before-submit");
      scenario.ledger.record("on-chain-submit", "pay-1");
      return { paymentId: "pay-1", transactionHash: "tx-1", status: "CONFIRMED" };
    });

    await expect(
      service.submitTransaction(signed, "stellar", "owner-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(scenario.killPoint.hasFired("after-claim-before-submit")).toBe(true);
    expect(repo.rows[0].state).toBe(PaymentOperationState.RECOVERY_REQUIRED);
    expect(scenario.ledger.count("pay-1")).toBe(0);

    scenario.restart();
    processor.getStatus.mockResolvedValue({
      status: "CONFIRMED",
      transactionHash: "tx-1",
    });
    processor.submitTransaction.mockClear();

    await expect(service.submitTransaction(signed, "stellar", "owner-1")).resolves.toMatchObject({
      transactionHash: "tx-1",
    });
    expect(processor.submitTransaction).not.toHaveBeenCalled();
    expect(repo.rows[0].state).toBe(PaymentOperationState.SUBMITTED);
    scenario.assertClean();
  });

  it("does not resubmit after a kill between submit and final save", async () => {
    const { scenario, repo, processor, service, signed } = makeScenario();
    scenario.killPoint.armKill("after-submit-before-save");
    processor.submitTransaction.mockImplementation(async () => {
      scenario.ledger.record("on-chain-submit", "pay-1");
      scenario.killPoint.checkpoint("after-submit-before-save");
      return { paymentId: "pay-1", transactionHash: "tx-1", status: "CONFIRMED" };
    });

    await expect(
      service.submitTransaction(signed, "stellar", "owner-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.rows[0].state).toBe(PaymentOperationState.RECOVERY_REQUIRED);
    expect(scenario.ledger.count("pay-1")).toBe(1);

    scenario.restart();
    processor.getStatus.mockResolvedValue({
      status: "CONFIRMED",
      transactionHash: "tx-1",
    });
    processor.submitTransaction.mockClear();

    await expect(service.submitTransaction(signed, "stellar", "owner-1")).resolves.toMatchObject({
      transactionHash: "tx-1",
    });
    expect(processor.submitTransaction).not.toHaveBeenCalled();
    expect(scenario.ledger.count("pay-1")).toBe(1);
    expect(repo.rows[0].state).toBe(PaymentOperationState.SUBMITTED);
    scenario.assertClean();
  });

  it("refuses recovery for another owner without touching the ledger", async () => {
    const { scenario, processor, service, signed } = makeScenario();

    await expect(
      service.submitTransaction(signed, "stellar", "other-owner"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(processor.submitTransaction).not.toHaveBeenCalled();
    expect(scenario.ledger.count("pay-1")).toBe(0);
    scenario.assertClean();
  });
});
