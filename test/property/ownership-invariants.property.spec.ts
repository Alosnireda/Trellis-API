import { Gen, assertProperty } from "../../src/testing/property-test-harness";

export enum OwnershipTransferStatus {
  PENDING = "pending",
  ACCEPTED = "accepted",
  REJECTED = "rejected",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

interface Resource {
  id: string;
  type: string;
  ownerId: string;
}

interface TransferRequest {
  id: string;
  resourceId: string;
  currentOwnerId: string;
  proposedOwnerId: string;
  status: OwnershipTransferStatus;
  createdAt: number;
  expiresAt: number;
  idempotencyKey?: string;
}

class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipError";
  }
}

class OwnershipManagerSimulator {
  private resources = new Map<string, Resource>();
  private transfers = new Map<string, TransferRequest>();
  private idempotencyCache = new Map<string, TransferRequest>();

  createResource(id: string, type: string, initialOwnerId: string): Resource {
    const res: Resource = { id, type, ownerId: initialOwnerId };
    this.resources.set(id, res);
    return res;
  }

  getResource(id: string): Resource | undefined {
    return this.resources.get(id);
  }

  getTransfer(id: string): TransferRequest | undefined {
    return this.transfers.get(id);
  }

  initiateTransfer(
    callerId: string,
    transferId: string,
    resourceId: string,
    proposedOwnerId: string,
    ttlMs: number = 3600_000,
    currentTime: number = Date.now(),
    idempotencyKey?: string,
  ): TransferRequest {
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) {
      return this.idempotencyCache.get(idempotencyKey)!;
    }

    const resource = this.resources.get(resourceId);
    if (!resource) throw new OwnershipError(`Resource ${resourceId} not found`);

    // Invariant: Caller must be the current owner
    if (resource.ownerId !== callerId) {
      throw new OwnershipError("Forbidden: Caller is not the current owner of this resource");
    }

    // Invariant: Cannot transfer to oneself
    if (callerId === proposedOwnerId) {
      throw new OwnershipError("BadRequest: Cannot transfer resource ownership to oneself");
    }

    const transfer: TransferRequest = {
      id: transferId,
      resourceId,
      currentOwnerId: resource.ownerId,
      proposedOwnerId,
      status: OwnershipTransferStatus.PENDING,
      createdAt: currentTime,
      expiresAt: currentTime + ttlMs,
      idempotencyKey,
    };

    this.transfers.set(transferId, transfer);
    if (idempotencyKey) this.idempotencyCache.set(idempotencyKey, transfer);
    return transfer;
  }

  acceptTransfer(
    callerId: string,
    transferId: string,
    currentTime: number = Date.now(),
    simulateFailure: boolean = false,
  ): Resource {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new OwnershipError(`Transfer ${transferId} not found`);

    const resource = this.resources.get(transfer.resourceId);
    if (!resource) throw new OwnershipError(`Resource ${transfer.resourceId} not found`);

    // Invariant: Expiry monotonicity
    if (currentTime >= transfer.expiresAt) {
      transfer.status = OwnershipTransferStatus.EXPIRED;
      throw new OwnershipError("Conflict: Transfer offer has expired");
    }

    // Invariant: Only proposed owner can accept
    if (callerId !== transfer.proposedOwnerId) {
      throw new OwnershipError("Forbidden: Caller is not the designated proposed owner");
    }

    // Invariant: Monotonic terminal state
    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new OwnershipError(`Conflict: Transfer is already in terminal state '${transfer.status}'`);
    }

    const previousOwnerId = resource.ownerId;
    try {
      resource.ownerId = transfer.proposedOwnerId;
      transfer.status = OwnershipTransferStatus.ACCEPTED;

      if (simulateFailure) {
        throw new Error("Simulated downstream failure during post-transfer commit");
      }
      return resource;
    } catch (err) {
      // Atomic rollback to previous owner
      resource.ownerId = previousOwnerId;
      transfer.status = OwnershipTransferStatus.PENDING;
      throw err;
    }
  }

  rejectTransfer(callerId: string, transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new OwnershipError(`Transfer ${transferId} not found`);

    if (callerId !== transfer.proposedOwnerId) {
      throw new OwnershipError("Forbidden: Caller is not the designated proposed owner");
    }
    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new OwnershipError(`Conflict: Transfer is already in terminal state '${transfer.status}'`);
    }

    transfer.status = OwnershipTransferStatus.REJECTED;
  }

  cancelTransfer(callerId: string, transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new OwnershipError(`Transfer ${transferId} not found`);

    if (callerId !== transfer.currentOwnerId) {
      throw new OwnershipError("Forbidden: Only initiating owner can cancel transfer");
    }
    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new OwnershipError(`Conflict: Transfer is already in terminal state '${transfer.status}'`);
    }

    transfer.status = OwnershipTransferStatus.CANCELLED;
  }
}

describe("Property Tests: Ownership Invariants", () => {
  it("invariant: single owner invariant holds under arbitrary valid transfer chains", async () => {
    const report = await assertProperty(
      "single owner invariant",
      Gen.array(
        Gen.record({
          transferId: Gen.string(8),
          nextOwner: Gen.string(8),
        }),
        1,
        15,
      ),
      (steps) => {
        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-1", "portfolio", "initial-owner");
        let currentOwner = "initial-owner";

        for (const step of steps) {
          if (step.nextOwner === currentOwner) continue;

          // Invariant: At all times before transfer, exactly 1 owner exists
          expect(res.ownerId).toBe(currentOwner);

          mgr.initiateTransfer(currentOwner, step.transferId, res.id, step.nextOwner);
          mgr.acceptTransfer(step.nextOwner, step.transferId);

          currentOwner = step.nextOwner;
          // Invariant: After acceptance, ownership successfully moved to nextOwner
          expect(res.ownerId).toBe(currentOwner);
        }
      },
      { iterations: 50, seed: 7007 },
    );

    expect(report.passed).toBe(true);
  });

  it("failure path: self-transfer is strictly forbidden across all randomized owner IDs", async () => {
    const report = await assertProperty(
      "no self-transfer",
      Gen.string(12),
      (ownerId) => {
        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-self", "portfolio", ownerId);

        expect(() =>
          mgr.initiateTransfer(ownerId, "tx-self", res.id, ownerId),
        ).toThrow("Cannot transfer resource ownership to oneself");

        expect(res.ownerId).toBe(ownerId);
      },
      { iterations: 50, seed: 8008 },
    );

    expect(report.passed).toBe(true);
  });

  it("authorization path: non-owners cannot initiate and third parties cannot accept", async () => {
    const report = await assertProperty(
      "authorization boundaries",
      Gen.record({
        owner: Gen.string(8),
        proposed: Gen.string(8),
        impostor: Gen.string(8),
      }),
      (scenario) => {
        if (
          scenario.owner === scenario.proposed ||
          scenario.owner === scenario.impostor ||
          scenario.proposed === scenario.impostor
        ) {
          return;
        }

        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-auth", "vault", scenario.owner);

        // Impostor attempts to initiate transfer
        expect(() =>
          mgr.initiateTransfer(scenario.impostor, "tx-fail-1", res.id, scenario.proposed),
        ).toThrow("Forbidden: Caller is not the current owner");

        // Legitimate owner initiates
        mgr.initiateTransfer(scenario.owner, "tx-legit", res.id, scenario.proposed);

        // Impostor attempts to accept
        expect(() =>
          mgr.acceptTransfer(scenario.impostor, "tx-legit"),
        ).toThrow("Forbidden: Caller is not the designated proposed owner");

        // Resource owner remains unchanged
        expect(res.ownerId).toBe(scenario.owner);
      },
      { iterations: 50, seed: 9009 },
    );

    expect(report.passed).toBe(true);
  });

  it("expiry invariant: transfers past expiration timestamp cannot be accepted", async () => {
    const report = await assertProperty(
      "expiry monotonicity",
      Gen.record({
        ttl: Gen.integer(1000, 60_000),
        elapsed: Gen.integer(60_001, 120_000),
      }),
      ({ ttl, elapsed }) => {
        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-exp", "contract", "alice");
        const startTime = 1000_000;

        mgr.initiateTransfer("alice", "tx-exp", res.id, "bob", ttl, startTime);

        // Bob attempts to accept after expiry
        expect(() =>
          mgr.acceptTransfer("bob", "tx-exp", startTime + elapsed),
        ).toThrow("Conflict: Transfer offer has expired");

        expect(mgr.getTransfer("tx-exp")?.status).toBe(OwnershipTransferStatus.EXPIRED);
        expect(res.ownerId).toBe("alice");
      },
      { iterations: 50, seed: 1010 },
    );

    expect(report.passed).toBe(true);
  });

  it("rollback behavior: atomic rollback preserves original owner when acceptance encounters failure", async () => {
    const report = await assertProperty(
      "atomic rollback on acceptance error",
      Gen.record({
        owner: Gen.string(8),
        proposed: Gen.string(8),
      }),
      ({ owner, proposed }) => {
        if (owner === proposed) return;

        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-rollback", "portfolio", owner);

        mgr.initiateTransfer(owner, "tx-roll", res.id, proposed);

        expect(() =>
          mgr.acceptTransfer(proposed, "tx-roll", Date.now(), true),
        ).toThrow("Simulated downstream failure");

        // Invariant: Ownership reverted safely to original owner
        expect(res.ownerId).toBe(owner);
        expect(mgr.getTransfer("tx-roll")?.status).toBe(OwnershipTransferStatus.PENDING);
      },
      { iterations: 50, seed: 2020 },
    );

    expect(report.passed).toBe(true);
  });

  it("terminal monotonicity & retry path: idempotency keys prevent duplicate transfer creation", async () => {
    const report = await assertProperty(
      "idempotent transfer initiation",
      Gen.record({
        transferId: Gen.string(8),
        key: Gen.string(12),
      }),
      ({ transferId, key }) => {
        const mgr = new OwnershipManagerSimulator();
        const res = mgr.createResource("res-idemp", "portfolio", "alice");

        const t1 = mgr.initiateTransfer("alice", transferId, res.id, "bob", 3600_000, 1000, key);
        // Duplicate call with same key
        const t2 = mgr.initiateTransfer("alice", "different-id", res.id, "bob", 3600_000, 1000, key);

        expect(t1.id).toBe(t2.id);
      },
      { iterations: 50, seed: 3030 },
    );

    expect(report.passed).toBe(true);
  });
});
