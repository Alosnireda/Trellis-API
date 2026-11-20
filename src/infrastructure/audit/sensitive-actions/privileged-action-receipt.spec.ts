import { createHmac, timingSafeEqual } from "crypto";
import {
  AuditActorType,
  SensitiveActionEvent,
  SensitiveActionStatus,
} from "../entities/sensitive-action-event.entity";
import {
  SensitiveAction,
  SensitiveActionScope,
} from "./sensitive-action.enum";
import {
  buildPrivilegedReceipt,
  hashPrivilegedReceipt,
  signPrivilegedReceipt,
  verifyPrivilegedReceipt,
  PRIVILEGED_ACTION_RECEIPT_SCHEMA,
  PRIVILEGED_ACTION_RECEIPT_ALGORITHM,
  PrivilegedReceiptSigner,
} from "./privileged-action-receipt";
import { BadRequestException } from "@nestjs/common";
import { ExportSigningService } from "../algorithms/export-signing.service";

describe("Signed Audit Receipts for Privileged Actions", () => {
  it("requires a configured signing key and rejects malformed signatures", () => {
    const oldExportKey = process.env.AUDIT_EXPORT_SIGNING_KEY;
    const oldAuditKey = process.env.AUDIT_SIGNING_KEY;
    try {
      delete process.env.AUDIT_EXPORT_SIGNING_KEY;
      delete process.env.AUDIT_SIGNING_KEY;
      expect(() => new ExportSigningService().sign("receipt")).toThrow(/not configured/);
      process.env.AUDIT_EXPORT_SIGNING_KEY = "synthetic-test-key";
      const signer = new ExportSigningService();
      const signature = signer.sign("receipt");
      expect(signer.verify("receipt", signature)).toBe(true);
      expect(signer.verify("changed receipt", signature)).toBe(false);
      expect(signer.verify("receipt", "invalid")).toBe(false);
    } finally {
      if (oldExportKey === undefined) delete process.env.AUDIT_EXPORT_SIGNING_KEY;
      else process.env.AUDIT_EXPORT_SIGNING_KEY = oldExportKey;
      if (oldAuditKey === undefined) delete process.env.AUDIT_SIGNING_KEY;
      else process.env.AUDIT_SIGNING_KEY = oldAuditKey;
    }
  });

  const secretKey = "test-audit-receipt-secret-key-2026";

  const fakeSigner: PrivilegedReceiptSigner = {
    sign: (payload: string) => createHmac("sha256", secretKey).update(payload).digest("hex"),
    verify: (payload: string, signature: string) => {
      const expected = createHmac("sha256", secretKey).update(payload).digest("hex");
      try {
        return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
      } catch {
        return false;
      }
    },
  };

  function createMockEvent(overrides: Partial<SensitiveActionEvent> = {}): SensitiveActionEvent {
    const event = new SensitiveActionEvent();
    event.id = "evt_01HXYZ1234567890ABCDEF";
    event.sequence = "42";
    event.action = SensitiveAction.ROLE_ASSIGNED;
    event.scope = SensitiveActionScope.ACCESS_CONTROL;
    event.actorId = "maint_admin_99";
    event.actorType = AuditActorType.MAINTAINER;
    event.actorRole = "admin";
    event.resourceType = "user";
    event.resourceId = "usr_target_123";
    event.reason = "Granted operator privileges following security review";
    event.status = SensitiveActionStatus.SUCCEEDED;
    event.eventHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    event.previousHash = "0000000000000000000000000000000000000000000000000000000000000000";
    event.occurredAt = new Date("2026-11-19T12:00:00.000Z");
    Object.assign(event, overrides);
    return event;
  }

  describe("Normal Path", () => {
    it("builds a canonical receipt, signs it, and verifies successfully", () => {
      const event = createMockEvent();
      const fixedDate = new Date("2026-11-19T12:05:00.000Z");
      const receipt = buildPrivilegedReceipt(event, fixedDate);

      expect(receipt.schema).toBe(PRIVILEGED_ACTION_RECEIPT_SCHEMA);
      expect(receipt.eventId).toBe(event.id);
      expect(receipt.sequence).toBe(event.sequence);
      expect(receipt.action).toBe(event.action);
      expect(receipt.status).toBe(SensitiveActionStatus.SUCCEEDED);
      expect(receipt.issuedAt).toBe(fixedDate.toISOString());

      const integrity = signPrivilegedReceipt(receipt, fakeSigner);

      expect(integrity.signingAlgorithm).toBe(PRIVILEGED_ACTION_RECEIPT_ALGORITHM);
      expect(integrity.receiptHash).toHaveLength(64);
      expect(integrity.signature).toHaveLength(64);

      const verification = verifyPrivilegedReceipt(receipt, integrity, fakeSigner);
      expect(verification.valid).toBe(true);
      expect(verification.errors).toEqual([]);
      expect(verification.recomputedHash).toBe(integrity.receiptHash);
    });

    it("issues receipts for FAILED terminal actions as well", () => {
      const failedEvent = createMockEvent({
        status: SensitiveActionStatus.FAILED,
        reason: "Failed authentication threshold exceeded",
      });
      const receipt = buildPrivilegedReceipt(failedEvent);
      expect(receipt.status).toBe(SensitiveActionStatus.FAILED);

      const integrity = signPrivilegedReceipt(receipt, fakeSigner);
      const verification = verifyPrivilegedReceipt(receipt, integrity, fakeSigner);
      expect(verification.valid).toBe(true);
    });
  });

  describe("Failure & Tamper Path", () => {
    it("detects tampered receipt attributes via hash mismatch", () => {
      const event = createMockEvent();
      const receipt = buildPrivilegedReceipt(event);
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);

      // Tamper with actorId
      const tampered = { ...receipt, actorId: "attacker_impersonator" };
      const verification = verifyPrivilegedReceipt(tampered, integrity, fakeSigner);

      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("Receipt hash mismatch"))).toBe(true);
    });

    it("detects tampered signature with invalid cryptographic check", () => {
      const event = createMockEvent();
      const receipt = buildPrivilegedReceipt(event);
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);

      // Mutate signature
      const corruptedIntegrity = {
        ...integrity,
        signature: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
      const verification = verifyPrivilegedReceipt(receipt, corruptedIntegrity, fakeSigner);

      expect(verification.valid).toBe(false);
      expect(verification.errors).toContain("Cryptographic signature validation failed");
    });

    it("rejects unknown receipt schema", () => {
      const event = createMockEvent();
      const receipt = buildPrivilegedReceipt(event);
      const tampered = { ...receipt, schema: "unknown/schema/v99" };
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);

      const verification = verifyPrivilegedReceipt(tampered, integrity, fakeSigner);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("Schema mismatch"))).toBe(true);
    });

    it("rejects unexpected signing algorithm", () => {
      const event = createMockEvent();
      const receipt = buildPrivilegedReceipt(event);
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);

      const corruptedIntegrity = { ...integrity, signingAlgorithm: "RSA-MD5" };
      const verification = verifyPrivilegedReceipt(receipt, corruptedIntegrity, fakeSigner);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("Unexpected signing algorithm"))).toBe(true);
    });

    it("refuses to issue receipt if event has non-terminal status", () => {
      const pendingEvent = createMockEvent({ status: "PENDING" as any });
      expect(() => buildPrivilegedReceipt(pendingEvent)).toThrow(BadRequestException);
    });

    it("refuses to issue receipt if event is missing eventHash", () => {
      const brokenEvent = createMockEvent({ eventHash: "" });
      expect(() => buildPrivilegedReceipt(brokenEvent)).toThrow(BadRequestException);
    });
  });

  describe("Retry & Determinism Path", () => {
    it("produces identical receipt hash and signature across retries with same input", () => {
      const event = createMockEvent();
      const fixedDate = new Date("2026-11-19T15:30:00.000Z");

      const receipt1 = buildPrivilegedReceipt(event, fixedDate);
      const integrity1 = signPrivilegedReceipt(receipt1, fakeSigner);

      const receipt2 = buildPrivilegedReceipt(event, fixedDate);
      const integrity2 = signPrivilegedReceipt(receipt2, fakeSigner);

      expect(receipt1).toEqual(receipt2);
      expect(integrity1.receiptHash).toBe(integrity2.receiptHash);
      expect(integrity1.signature).toBe(integrity2.signature);
    });
  });

  describe("Edge Cases & Serialization Invariants", () => {
    it("handles null and undefined fields deterministically in canonical JSON", () => {
      const event = createMockEvent({
        actorRole: null,
        resourceType: null,
        resourceId: null,
        reason: null,
        previousHash: null,
      });

      const receipt = buildPrivilegedReceipt(event);
      const hash1 = hashPrivilegedReceipt(receipt);
      const hash2 = hashPrivilegedReceipt(receipt);

      expect(hash1).toBe(hash2);
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);
      expect(verifyPrivilegedReceipt(receipt, integrity, fakeSigner).valid).toBe(true);
    });

    it("handles unicode and special characters in reason without canonical drift", () => {
      const event = createMockEvent({
        reason: "Reason with quotes: \"test\", linebreaks: \n\t, and unicode: 🛡️ ✨ \u0000",
      });

      const receipt = buildPrivilegedReceipt(event);
      const integrity = signPrivilegedReceipt(receipt, fakeSigner);
      const verification = verifyPrivilegedReceipt(receipt, integrity, fakeSigner);

      expect(verification.valid).toBe(true);
    });
  });
});
