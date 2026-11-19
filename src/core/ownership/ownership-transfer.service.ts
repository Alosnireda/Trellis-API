import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  OwnershipTransfer,
  OwnershipTransferAuditAction,
  OwnershipTransferAuditEvent,
  OwnershipTransferStatus,
} from "./entities/ownership-transfer.entity";

export interface InitiateTransferDto {
  resourceType: string;
  resourceId: string;
  currentOwnerId: string;
  proposedOwnerId: string;
  expiresInHours?: number;
  idempotencyKey?: string;
}

@Injectable()
export class OwnershipTransferService {
  private readonly logger = new Logger(OwnershipTransferService.name);

  // In-memory store fallback for environments without DB or for testing
  private inMemoryStore = new Map<string, OwnershipTransfer>();
  private inMemoryAuditStore = new Map<string, OwnershipTransferAuditEvent[]>();

  constructor(
    @Optional()
    @InjectRepository(OwnershipTransfer)
    private readonly transferRepo?: Repository<OwnershipTransfer>,
    @Optional()
    @InjectRepository(OwnershipTransferAuditEvent)
    private readonly auditRepo?: Repository<OwnershipTransferAuditEvent>,
  ) {}

  /**
   * Initiates a two-step ownership transfer request.
   */
  async initiateTransfer(dto: InitiateTransferDto): Promise<OwnershipTransfer> {
    if (dto.currentOwnerId === dto.proposedOwnerId) {
      throw new BadRequestException("Cannot transfer ownership to yourself.");
    }

    if (!dto.resourceType || !dto.resourceId) {
      throw new BadRequestException("resourceType and resourceId are required.");
    }

    if (dto.idempotencyKey) {
      const idempotentMatch = await this.findByIdempotencyKey(dto.idempotencyKey);
      if (idempotentMatch) {
        const sameRequest =
          idempotentMatch.resourceType === dto.resourceType &&
          idempotentMatch.resourceId === dto.resourceId &&
          idempotentMatch.currentOwnerId === dto.currentOwnerId &&
          idempotentMatch.proposedOwnerId === dto.proposedOwnerId;
        if (!sameRequest) {
          throw new ConflictException(
            `Idempotency key '${dto.idempotencyKey}' is already bound to a different transfer.`,
          );
        }
        await this.recordAuditEvent({
          transferId: idempotentMatch.id,
          action: OwnershipTransferAuditAction.RETRIED_NOOP,
          actorId: dto.currentOwnerId,
          fromStatus: idempotentMatch.status,
          toStatus: idempotentMatch.status,
          reason: "Idempotent initiateTransfer retry",
          metadata: { idempotencyKey: dto.idempotencyKey },
        });
        return idempotentMatch;
      }
    }

    // Check for existing pending transfer for this resource
    const existing = await this.findPendingByResource(dto.resourceType, dto.resourceId);
    if (existing && !this.isExpired(existing)) {
      throw new ConflictException(
        `A pending ownership transfer already exists for ${dto.resourceType}:${dto.resourceId}`,
      );
    }

    const expiresInHours = dto.expiresInHours && dto.expiresInHours > 0 ? dto.expiresInHours : 72;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const transfer: OwnershipTransfer = {
      id: `ot_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      currentOwnerId: dto.currentOwnerId,
      proposedOwnerId: dto.proposedOwnerId,
      status: OwnershipTransferStatus.PENDING,
      expiresAt,
      idempotencyKey: dto.idempotencyKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const saved = await this.save(transfer);
    await this.recordAuditEvent({
      transferId: saved.id,
      action: OwnershipTransferAuditAction.INITIATED,
      actorId: dto.currentOwnerId,
      fromStatus: null,
      toStatus: OwnershipTransferStatus.PENDING,
      metadata: {
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        proposedOwnerId: dto.proposedOwnerId,
        expiresAt: expiresAt.toISOString(),
      },
    });

    this.logger.log(
      `Initiated ownership transfer ${saved.id} for ${dto.resourceType}:${dto.resourceId} to ${dto.proposedOwnerId}`,
    );
    return saved;
  }

  /**
   * Proposed owner accepts the pending transfer within the validity window.
   */
  async acceptTransfer(transferId: string, actorId: string): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (this.isExpired(transfer) && transfer.status === OwnershipTransferStatus.PENDING) {
      transfer.status = OwnershipTransferStatus.EXPIRED;
      transfer.updatedAt = new Date();
      await this.save(transfer);
      await this.recordAuditEvent({
        transferId: transfer.id,
        action: OwnershipTransferAuditAction.EXPIRED,
        actorId,
        fromStatus: OwnershipTransferStatus.PENDING,
        toStatus: OwnershipTransferStatus.EXPIRED,
        reason: "Transfer expired before acceptance",
      });
      throw new BadRequestException("Ownership transfer request has expired.");
    }

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(
        `Cannot accept transfer with status '${transfer.status}'. Only PENDING transfers can be accepted.`,
      );
    }

    if (transfer.proposedOwnerId !== actorId) {
      await this.recordAuditEvent({
        transferId: transfer.id,
        action: OwnershipTransferAuditAction.ACCESS_DENIED,
        actorId,
        fromStatus: transfer.status,
        toStatus: transfer.status,
        reason: "Unauthorized accept attempt by non-proposed owner",
      });
      throw new ForbiddenException(
        "Only the proposed owner is authorized to accept this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.ACCEPTED;
    transfer.acceptedAt = new Date();
    transfer.updatedAt = new Date();

    const saved = await this.save(transfer);
    await this.recordAuditEvent({
      transferId: saved.id,
      action: OwnershipTransferAuditAction.ACCEPTED,
      actorId,
      fromStatus: OwnershipTransferStatus.PENDING,
      toStatus: OwnershipTransferStatus.ACCEPTED,
    });
    this.logger.log(
      `Ownership transfer ${transferId} ACCEPTED by ${actorId}. Ownership transitioned from ${transfer.currentOwnerId}.`,
    );
    return saved;
  }

  /**
   * Current owner cancels an unaccepted transfer before expiration.
   */
  async cancelTransfer(
    transferId: string,
    actorId: string,
    reason?: string,
  ): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(
        `Cannot cancel transfer with status '${transfer.status}'.`,
      );
    }

    if (transfer.currentOwnerId !== actorId) {
      await this.recordAuditEvent({
        transferId: transfer.id,
        action: OwnershipTransferAuditAction.ACCESS_DENIED,
        actorId,
        fromStatus: transfer.status,
        toStatus: transfer.status,
        reason: "Unauthorized cancel attempt by non-owner",
      });
      throw new ForbiddenException(
        "Only the current owner is authorized to cancel this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.CANCELLED;
    transfer.cancelledAt = new Date();
    transfer.cancellationReason = reason ?? "Cancelled by initiator";
    transfer.updatedAt = new Date();

    const saved = await this.save(transfer);
    await this.recordAuditEvent({
      transferId: saved.id,
      action: OwnershipTransferAuditAction.CANCELLED,
      actorId,
      fromStatus: OwnershipTransferStatus.PENDING,
      toStatus: OwnershipTransferStatus.CANCELLED,
      reason: saved.cancellationReason,
    });
    this.logger.log(`Ownership transfer ${transferId} CANCELLED by ${actorId}.`);
    return saved;
  }

  /**
   * Proposed owner declines an unaccepted transfer.
   */
  async rejectTransfer(
    transferId: string,
    actorId: string,
    reason?: string,
  ): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);

    if (transfer.status !== OwnershipTransferStatus.PENDING) {
      throw new BadRequestException(`Cannot reject transfer with status '${transfer.status}'.`);
    }

    if (transfer.proposedOwnerId !== actorId) {
      await this.recordAuditEvent({
        transferId: transfer.id,
        action: OwnershipTransferAuditAction.ACCESS_DENIED,
        actorId,
        fromStatus: transfer.status,
        toStatus: transfer.status,
        reason: "Unauthorized reject attempt by non-proposed owner",
      });
      throw new ForbiddenException(
        "Only the proposed owner is authorized to reject this transfer.",
      );
    }

    transfer.status = OwnershipTransferStatus.REJECTED;
    transfer.rejectedAt = new Date();
    transfer.rejectionReason = reason ?? "Rejected by proposed owner";
    transfer.updatedAt = new Date();

    const saved = await this.save(transfer);
    await this.recordAuditEvent({
      transferId: saved.id,
      action: OwnershipTransferAuditAction.REJECTED,
      actorId,
      fromStatus: OwnershipTransferStatus.PENDING,
      toStatus: OwnershipTransferStatus.REJECTED,
      reason: saved.rejectionReason,
    });
    return saved;
  }

  /**
   * Retrieve a transfer by ID, enforcing participant authorization (when actorId is given)
   * and automatically resolving expiry.
   */
  async getTransfer(transferId: string, actorId?: string): Promise<OwnershipTransfer> {
    const transfer = await this.getTransferById(transferId);
    if (actorId) {
      await this.assertParticipant(transfer, actorId);
    }
    if (transfer.status === OwnershipTransferStatus.PENDING && this.isExpired(transfer)) {
      transfer.status = OwnershipTransferStatus.EXPIRED;
      transfer.updatedAt = new Date();
      const saved = await this.save(transfer);
      await this.recordAuditEvent({
        transferId: saved.id,
        action: OwnershipTransferAuditAction.EXPIRED,
        actorId: actorId ?? "system:lazy-expiry",
        fromStatus: OwnershipTransferStatus.PENDING,
        toStatus: OwnershipTransferStatus.EXPIRED,
        reason: "Expired on read",
      });
      return saved;
    }
    return transfer;
  }

  /**
   * Retrieve chronological audit history for a transfer.
   */
  async getAuditHistory(
    transferId: string,
    actorId?: string,
  ): Promise<OwnershipTransferAuditEvent[]> {
    const transfer = await this.getTransferById(transferId);
    if (actorId) {
      await this.assertParticipant(transfer, actorId);
    }
    if (this.auditRepo) {
      return await this.auditRepo.find({
        where: { transferId },
        order: { occurredAt: "ASC" },
      });
    }
    return [...(this.inMemoryAuditStore.get(transferId) ?? [])];
  }

  /**
   * Idempotently expire all pending transfers whose expiresAt has passed.
   */
  async expirePendingTransfers(): Promise<number> {
    const all = this.transferRepo
      ? await this.transferRepo.find({ where: { status: OwnershipTransferStatus.PENDING } })
      : Array.from(this.inMemoryStore.values()).filter(
          (t) => t.status === OwnershipTransferStatus.PENDING,
        );

    let expiredCount = 0;
    for (const transfer of all) {
      if (this.isExpired(transfer)) {
        transfer.status = OwnershipTransferStatus.EXPIRED;
        transfer.updatedAt = new Date();
        await this.save(transfer);
        await this.recordAuditEvent({
          transferId: transfer.id,
          action: OwnershipTransferAuditAction.EXPIRED,
          actorId: "system:expiry-sweep",
          fromStatus: OwnershipTransferStatus.PENDING,
          toStatus: OwnershipTransferStatus.EXPIRED,
          reason: "Expired during scheduled sweep",
        });
        expiredCount += 1;
      }
    }
    return expiredCount;
  }

  /**
   * List pending transfers for a user.
   */
  async listTransfers(
    userId: string,
    direction: "incoming" | "outgoing" | "all" = "all",
  ): Promise<OwnershipTransfer[]> {
    let all: OwnershipTransfer[] = [];

    if (this.transferRepo) {
      all = await this.transferRepo.find();
    } else {
      all = Array.from(this.inMemoryStore.values());
    }

    // Refresh expiry
    for (const t of all) {
      if (t.status === OwnershipTransferStatus.PENDING && this.isExpired(t)) {
        t.status = OwnershipTransferStatus.EXPIRED;
        await this.save(t);
      }
    }

    return all.filter((t) => {
      if (direction === "incoming") return t.proposedOwnerId === userId;
      if (direction === "outgoing") return t.currentOwnerId === userId;
      return t.currentOwnerId === userId || t.proposedOwnerId === userId;
    });
  }

  private isExpired(transfer: OwnershipTransfer): boolean {
    return new Date(transfer.expiresAt).getTime() <= Date.now();
  }

  private async getTransferById(id: string): Promise<OwnershipTransfer> {
    if (this.transferRepo) {
      const found = await this.transferRepo.findOne({ where: { id } });
      if (!found) throw new NotFoundException(`Ownership transfer '${id}' not found.`);
      return found;
    }

    const found = this.inMemoryStore.get(id);
    if (!found) throw new NotFoundException(`Ownership transfer '${id}' not found.`);
    return found;
  }

  private async findPendingByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<OwnershipTransfer | null> {
    if (this.transferRepo) {
      return await this.transferRepo.findOne({
        where: {
          resourceType,
          resourceId,
          status: OwnershipTransferStatus.PENDING,
        },
      });
    }

    for (const t of this.inMemoryStore.values()) {
      if (
        t.resourceType === resourceType &&
        t.resourceId === resourceId &&
        t.status === OwnershipTransferStatus.PENDING
      ) {
        return t;
      }
    }
    return null;
  }

  private async save(transfer: OwnershipTransfer): Promise<OwnershipTransfer> {
    if (this.transferRepo) {
      return await this.transferRepo.save(transfer);
    }
    this.inMemoryStore.set(transfer.id, transfer);
    return transfer;
  }

  private async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<OwnershipTransfer | null> {
    if (this.transferRepo) {
      return await this.transferRepo.findOne({ where: { idempotencyKey } });
    }
    for (const t of this.inMemoryStore.values()) {
      if (t.idempotencyKey === idempotencyKey) {
        return t;
      }
    }
    return null;
  }

  private async assertParticipant(
    transfer: OwnershipTransfer,
    actorId: string,
  ): Promise<void> {
    if (transfer.currentOwnerId !== actorId && transfer.proposedOwnerId !== actorId) {
      await this.recordAuditEvent({
        transferId: transfer.id,
        action: OwnershipTransferAuditAction.ACCESS_DENIED,
        actorId,
        fromStatus: transfer.status,
        toStatus: transfer.status,
        reason: "Unauthorized read attempt by non-participant",
      });
      throw new ForbiddenException(
        "Only the current owner or proposed owner may access this ownership transfer.",
      );
    }
  }

  private async recordAuditEvent(params: {
    transferId: string;
    action: OwnershipTransferAuditAction;
    actorId: string;
    fromStatus: OwnershipTransferStatus | null;
    toStatus: OwnershipTransferStatus | null;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OwnershipTransferAuditEvent> {
    const event: OwnershipTransferAuditEvent = {
      id: `ota_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      transferId: params.transferId,
      action: params.action,
      actorId: params.actorId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      reason: params.reason ?? null,
      metadata: params.metadata ?? null,
      occurredAt: new Date(),
    };

    if (this.auditRepo) {
      return await this.auditRepo.save(event);
    }

    const existing = this.inMemoryAuditStore.get(params.transferId) ?? [];
    existing.push(event);
    this.inMemoryAuditStore.set(params.transferId, existing);
    return event;
  }
}
