import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { NotificationChannel } from "../entities/notification.entity";
import { DeliveryStatus } from "../entities/notification-delivery-log.entity";

export enum ReceiptOverallStatus {
  PENDING = "PENDING",
  DELIVERED = "DELIVERED",
  PARTIALLY_DELIVERED = "PARTIALLY_DELIVERED",
  FAILED = "FAILED",
  SUPPRESSED = "SUPPRESSED",
}

export class ChannelDeliveryReceiptDto {
  @ApiProperty({ enum: NotificationChannel })
  channel: NotificationChannel;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiProperty({ example: 1 })
  attemptCount: number;

  @ApiPropertyOptional()
  provider?: string;

  @ApiPropertyOptional()
  providerMessageId?: string;

  @ApiPropertyOptional()
  sentAt?: string;

  @ApiPropertyOptional()
  deliveredAt?: string;

  @ApiPropertyOptional()
  errorMessage?: string;
}

export class DeliveryReceiptDto {
  @ApiProperty({ example: "rcpt-550e8400-e29b-41d4-a716-446655440000" })
  receiptId: string;

  @ApiProperty({ example: "notif-98f2c3d4-b716-4466-a716-446655440000" })
  notificationId: string;

  @ApiProperty({ example: "user-123" })
  userId: string;

  @ApiPropertyOptional({ example: "circuit-breaker-trip-2026-09-26-001" })
  deduplicationKey?: string;

  @ApiProperty({
    description: "True if this delivery was satisfied by an existing duplicate submission",
    example: false,
  })
  isDuplicate: boolean;

  @ApiProperty({ enum: ReceiptOverallStatus, example: ReceiptOverallStatus.DELIVERED })
  deliveryStatus: ReceiptOverallStatus;

  @ApiProperty({ type: [ChannelDeliveryReceiptDto] })
  channelReceipts: ChannelDeliveryReceiptDto[];

  @ApiProperty({
    description: "Cryptographic SHA-256 HMAC verification digest ensuring receipt integrity",
    example: "8f4e2c1b9a...",
  })
  receiptSignature: string;

  @ApiProperty({ example: "2026-11-19T14:00:00.000Z" })
  issuedAt: string;

  @ApiProperty({ example: "2026-11-19T14:00:00.000Z" })
  originalSubmittedAt: string;
}

