import { createHash } from "crypto";
import { canonicalJson } from "../../../common/serialization/canonical-json";
import {
  AuditActorType,
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";
import {
  SensitiveAction,
  SensitiveActionScope,
} from "./sensitive-action.enum";
import { BadRequestException } from "@nestjs/common";

export const PRIVILEGED_ACTION_RECEIPT_SCHEMA = "trellis/privileged-action-receipt/v1";
export const PRIVILEGED_ACTION_RECEIPT_ALGORITHM = "HMAC-SHA256";

/**
 * Structural signer contract for audit receipts.
 */
export interface PrivilegedReceiptSigner {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

/**
 * Canonical payload committed to by a signed privileged action receipt.
 */
export interface PrivilegedActionReceipt {
  schema: string;
  receiptId: string;
  eventId: string;
  sequence: string;
  action: SensitiveAction;
  scope: SensitiveActionScope;
  actorId: string;
  actorType: AuditActorType;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  reason: string | null;
  status: SensitiveActionStatus;
  eventHash: string;
  previousHash: string | null;
  occurredAt: string;
  issuedAt: string;
}

export interface PrivilegedReceiptIntegrity {
  receiptHash: string;
  signature: string;
  signingAlgorithm: string;
}

export interface PrivilegedReceiptVerification {
  valid: boolean;
  recomputedHash: string;
  errors: string[];
}

/**
 * Builds a deterministic receipt document from a recorded SensitiveActionEvent.
 * Only terminal events (SUCCEEDED or FAILED) can receive a signed audit receipt.
 */
export function buildPrivilegedReceipt(
  event: SensitiveActionEvent,
  issuedAt: Date = new Date(),
): PrivilegedActionReceipt {
  if (
    event.status !== SensitiveActionStatus.SUCCEEDED &&
    event.status !== SensitiveActionStatus.FAILED
  ) {
    throw new BadRequestException(
      `Cannot issue audit receipt for non-terminal sensitive action status: ${event.status}`,
    );
  }

  if (!event.eventHash) {
    throw new BadRequestException(
      `Sensitive action event ${event.id} is missing its recorded eventHash`,
    );
  }

  const receiptId = `rcpt_${createHash("sha256")
    .update(`${event.id}:${event.sequence}:${event.eventHash}`)
    .digest("hex")
    .slice(0, 32)}`;

  return {
    schema: PRIVILEGED_ACTION_RECEIPT_SCHEMA,
    receiptId,
    eventId: event.id,
    sequence: event.sequence,
    action: event.action,
    scope: event.scope,
    actorId: event.actorId,
    actorType: event.actorType,
    actorRole: event.actorRole ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    reason: event.reason ?? null,
    status: event.status,
    eventHash: event.eventHash,
    previousHash: event.previousHash ?? null,
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString(),
    issuedAt: issuedAt.toISOString(),
  };
}

/**
 * Returns canonical JSON representation of the receipt document.
 */
export function receiptCanonicalBytes(receipt: PrivilegedActionReceipt): string {
  return canonicalJson(receipt);
}

/**
 * Computes SHA-256 digest of canonical receipt bytes.
 */
export function hashPrivilegedReceipt(receipt: PrivilegedActionReceipt): string {
  return createHash("sha256")
    .update(receiptCanonicalBytes(receipt))
    .digest("hex");
}

/**
 * Signs the receipt hash using the supplied cryptographic signer.
 */
export function signPrivilegedReceipt(
  receipt: PrivilegedActionReceipt,
  signer: PrivilegedReceiptSigner,
): PrivilegedReceiptIntegrity {
  const receiptHash = hashPrivilegedReceipt(receipt);
  return {
    receiptHash,
    signature: signer.sign(receiptHash),
    signingAlgorithm: PRIVILEGED_ACTION_RECEIPT_ALGORITHM,
  };
}

/**
 * Verifies the integrity and signature of a privileged action receipt.
 * Never throws: reports errors in the returned verification object.
 */
export function verifyPrivilegedReceipt(
  receipt: PrivilegedActionReceipt,
  integrity: PrivilegedReceiptIntegrity,
  signer: PrivilegedReceiptSigner,
): PrivilegedReceiptVerification {
  const errors: string[] = [];

  if (!receipt || typeof receipt !== "object") {
    return {
      valid: false,
      recomputedHash: "",
      errors: ["Receipt object is missing or malformed"],
    };
  }

  if (receipt.schema !== PRIVILEGED_ACTION_RECEIPT_SCHEMA) {
    errors.push(
      `Schema mismatch: expected '${PRIVILEGED_ACTION_RECEIPT_SCHEMA}', got '${receipt.schema}'`,
    );
  }

  let recomputedHash = "";
  try {
    recomputedHash = hashPrivilegedReceipt(receipt);
  } catch (err) {
    errors.push(`Canonical serialization error: ${(err as Error).message}`);
    return { valid: false, recomputedHash: "", errors };
  }

  if (!integrity || typeof integrity !== "object") {
    errors.push("Integrity block is missing or malformed");
    return { valid: false, recomputedHash, errors };
  }

  if (integrity.signingAlgorithm !== PRIVILEGED_ACTION_RECEIPT_ALGORITHM) {
    errors.push(
      `Unexpected signing algorithm: '${integrity.signingAlgorithm}', expected '${PRIVILEGED_ACTION_RECEIPT_ALGORITHM}'`,
    );
  }

  if (integrity.receiptHash !== recomputedHash) {
    errors.push(
      `Receipt hash mismatch: expected '${recomputedHash}', recorded '${integrity.receiptHash}'`,
    );
  }

  let signatureValid = false;
  try {
    signatureValid = signer.verify(recomputedHash, integrity.signature);
  } catch (err) {
    errors.push(`Signature verification error: ${(err as Error).message}`);
  }

  if (!signatureValid && !errors.some((e) => e.includes("Signature verification error"))) {
    errors.push("Cryptographic signature validation failed");
  }

  return {
    valid: errors.length === 0,
    recomputedHash,
    errors,
  };
}
