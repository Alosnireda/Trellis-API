import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum OwnershipTransferStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
}

export enum OwnershipTransferAuditAction {
  INITIATED = "INITIATED",
  ACCEPTED = "ACCEPTED",
  CANCELLED = "CANCELLED",
  REJECTED = "REJECTED",
  EXPIRED = "EXPIRED",
  RETRIED_NOOP = "RETRIED_NOOP",
  ACCESS_DENIED = "ACCESS_DENIED",
}

@Entity("ownership_transfers")
@Index(["resourceType", "resourceId", "status"])
@Index(["proposedOwnerId", "status"])
@Index(["currentOwnerId", "status"])
export class OwnershipTransfer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  resourceType!: string;

  @Column({ type: "varchar", length: 128 })
  resourceId!: string;

  @Column({ type: "varchar", length: 128 })
  currentOwnerId!: string;

  @Column({ type: "varchar", length: 128 })
  proposedOwnerId!: string;

  @Column({
    type: "varchar",
    length: 32,
    default: OwnershipTransferStatus.PENDING,
  })
  status!: OwnershipTransferStatus;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt?: Date;

  @Column({ type: "timestamptz", nullable: true })
  cancelledAt?: Date;

  @Column({ type: "varchar", length: 255, nullable: true })
  cancellationReason?: string;

  @Column({ type: "timestamptz", nullable: true })
  rejectedAt?: Date;

  @Column({ type: "varchar", length: 255, nullable: true })
  rejectionReason?: string;

  @Index()
  @Column({ type: "varchar", length: 128, nullable: true })
  idempotencyKey?: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("ownership_transfer_audit_events")
@Index(["transferId", "occurredAt"])
export class OwnershipTransferAuditEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  transferId!: string;

  @Column({ type: "varchar", length: 32 })
  action!: OwnershipTransferAuditAction;

  @Column({ type: "varchar", length: 128 })
  actorId!: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  fromStatus?: OwnershipTransferStatus | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  toStatus?: OwnershipTransferStatus | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  reason?: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, unknown> | null;

  @CreateDateColumn({ type: "timestamptz" })
  occurredAt!: Date;
}
