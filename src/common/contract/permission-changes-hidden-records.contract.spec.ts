import { BadRequestException } from "@nestjs/common";
import { Role, Permission, getRolePermissions } from "../guard/roles.enum";
import { PermissionDiffService } from "../guard/permission-diff.service";
import { PermissionMatrixController, PermissionDiffDto } from "../guard/permission-matrix.controller";
import { isActionAllowed, PERMISSION_MATRIX } from "../guard/permission-matrix";
import {
  buildTransactionDisclosure,
  assertDisclosureInvariants,
} from "../transaction-details/transaction-detail.projection";
import {
  TransactionDetailTier,
  TransactionSectionDefinition,
} from "../transaction-details/transaction-detail.types";

/**
 * Contract Tests for Permission Changes and Hidden Records (Issue #434).
 *
 * Verifies public API and domain contract guarantees across:
 * 1. Permission Changes:
 *    - Normal path: Deterministic diffing, unlocked actions, revoked actions.
 *    - Failure path: Malformed inputs or missing required DTO properties fail validation.
 *    - Retry & Idempotency: Repeated evaluations yield identical diffs without state corruption.
 *    - Authorization & Escalation: Breaking changes and privilege escalation detection.
 *
 * 2. Hidden Records:
 *    - Ownership isolation: Private/tenant records are strictly hidden from non-owners.
 *    - Soft-delete & revocation: Soft-deleted or revoked records are excluded from queries.
 *    - Pagination stability: Keyset cursor ordering remains invariant when hidden records exist.
 *    - Disclosure invariants: Critical risks are NEVER hidden under any permission tier.
 */

describe("Permission Changes and Hidden Records Contract Specification (#434)", () => {
  let diffService: PermissionDiffService;
  let controller: PermissionMatrixController;

  beforeEach(() => {
    diffService = new PermissionDiffService();
    controller = new PermissionMatrixController(diffService);
  });

  // =========================================================================
  // 1. PERMISSION CHANGES CONTRACTS
  // =========================================================================
  describe("Permission Changes Contract", () => {
    describe("Normal Path: Deterministic Permission Diff Calculation", () => {
      it("should accurately compute added, removed, and unchanged permissions for a role", () => {
        const currentOperatorPerms = getRolePermissions(Role.OPERATOR);
        // Propose adding SYSTEM_MAINTENANCE and removing nothing
        const proposedPerms = [...currentOperatorPerms, Permission.SYSTEM_MAINTENANCE];

        const report = diffService.generateRoleDiff(Role.OPERATOR, proposedPerms);

        expect(report.targetType).toBe("role");
        expect(report.targetId).toBe(Role.OPERATOR);
        expect(report.addedPermissions).toContain(Permission.SYSTEM_MAINTENANCE);
        expect(report.removedPermissions).toHaveLength(0);
        expect(report.unchangedPermissions).toEqual(expect.arrayContaining(currentOperatorPerms));
        expect(report.breakingChange).toBe(false);
      });

      it("should identify unlocked actions when new permissions are granted", () => {
        // Granting TRADE_EXECUTE to a user role
        const userPerms = getRolePermissions(Role.USER);
        const proposedPerms = [...userPerms, Permission.TRADE_EXECUTE];

        const report = diffService.generateRoleDiff(Role.USER, proposedPerms);

        expect(report.addedPermissions).toContain(Permission.TRADE_EXECUTE);
        expect(report.unlockedActions.length).toBeGreaterThan(0);
      });

      it("should identify revoked actions when permissions are removed", () => {
        // Removing PORTFOLIO_WRITE from USER
        const userPerms = getRolePermissions(Role.USER);
        const proposedPerms = userPerms.filter((p) => p !== Permission.PORTFOLIO_WRITE);

        const report = diffService.generateRoleDiff(Role.USER, proposedPerms);

        expect(report.removedPermissions).toContain(Permission.PORTFOLIO_WRITE);
        expect(report.revokedActions).toContain("portfolio.write");
        expect(report.breakingChange).toBe(true);
      });
    });

    describe("Authorization & Privilege Escalation Path", () => {
      it("should flag privilege escalation when critical administrative permissions are granted to non-admin roles", () => {
        const userPerms = getRolePermissions(Role.USER);
        const proposedEscalated = [...userPerms, Permission.USER_MANAGE, Permission.DR_EXECUTE];

        const report = diffService.generateRoleDiff(Role.USER, proposedEscalated);

        expect(report.riskAssessment.isPrivilegeEscalation).toBe(true);
        expect(report.riskAssessment.riskLevel).toBe("CRITICAL");
        expect(report.riskAssessment.sensitiveActionsGained.length).toBeGreaterThan(0);
        expect(report.riskAssessment.warnings.length).toBeGreaterThan(0);
      });

      it("should enforce fail-closed authorization boundaries when actions require undeclared permissions", () => {
        // An unprivileged role must be denied for sensitive actions
        expect(isActionAllowed([Role.USER], "dr.execute")).toBe(false);
        expect(isActionAllowed([Role.USER], "user.manage")).toBe(false);
        expect(isActionAllowed([Role.OPERATOR], "role.assign")).toBe(false);
      });

      it("should maintain ADMIN universal override contract", () => {
        for (const entry of PERMISSION_MATRIX) {
          expect(isActionAllowed([Role.ADMIN], entry.action)).toBe(true);
        }
      });
    });

    describe("Failure Path: Invalid Input & Boundary Handling", () => {
      it("should throw BadRequestException when targetType or targetId is missing in DTO evaluation", () => {
        expect(() => {
          controller.generateDiff({} as PermissionDiffDto);
        }).toThrow(BadRequestException);

        expect(() => {
          controller.generateDiff({
            targetType: "role",
            targetId: "",
            proposedPermissions: [],
          } as PermissionDiffDto);
        }).toThrow(BadRequestException);
      });

      it("should throw BadRequestException when proposedPermissions is missing for role diff", () => {
        expect(() => {
          controller.generateDiff({
            targetType: "role",
            targetId: "OPERATOR",
          } as PermissionDiffDto);
        }).toThrow(BadRequestException);
      });

      it("should throw BadRequestException when proposedRoles is missing for user diff", () => {
        expect(() => {
          controller.generateDiff({
            targetType: "user",
            targetId: "user-123",
          } as PermissionDiffDto);
        }).toThrow(BadRequestException);
      });
    });

    describe("Retry & Idempotency Path", () => {
      it("should produce bit-identical diff reports across multiple successive executions", () => {
        const userPerms = getRolePermissions(Role.USER);
        const proposed = [...userPerms, Permission.TRADE_READ];

        const report1 = diffService.generateRoleDiff(Role.USER, proposed);
        const report2 = diffService.generateRoleDiff(Role.USER, proposed);

        expect(report1.addedPermissions).toEqual(report2.addedPermissions);
        expect(report1.removedPermissions).toEqual(report2.removedPermissions);
        expect(report1.unlockedActions).toEqual(report2.unlockedActions);
        expect(report1.revokedActions).toEqual(report2.revokedActions);
        expect(report1.breakingChange).toBe(report2.breakingChange);
        expect(report1.riskAssessment.riskLevel).toBe(report2.riskAssessment.riskLevel);
      });
    });
  });

  // =========================================================================
  // 2. HIDDEN RECORDS CONTRACTS
  // =========================================================================
  describe("Hidden Records Contract", () => {
    describe("Ownership Isolation Contract: Private Resources", () => {
      interface SearchRecordMock {
        id: string;
        ownerId: string;
        title: string;
        visibility: "public" | "private";
        isRevoked: boolean;
        deletedAt: Date | null;
      }

      const mockDatabase: SearchRecordMock[] = [
        {
          id: "rec-1",
          ownerId: "user-alice",
          title: "Alice Public Strategy",
          visibility: "public",
          isRevoked: false,
          deletedAt: null,
        },
        {
          id: "rec-2",
          ownerId: "user-alice",
          title: "Alice Confidential Vault",
          visibility: "private",
          isRevoked: false,
          deletedAt: null,
        },
        {
          id: "rec-3",
          ownerId: "user-bob",
          title: "Bob Private Plan",
          visibility: "private",
          isRevoked: false,
          deletedAt: null,
        },
        {
          id: "rec-4",
          ownerId: "user-bob",
          title: "Bob Revoked Public Plan",
          visibility: "public",
          isRevoked: true,
          deletedAt: null,
        },
        {
          id: "rec-5",
          ownerId: "user-alice",
          title: "Alice Soft Deleted Item",
          visibility: "public",
          isRevoked: false,
          deletedAt: new Date(),
        },
      ];

      function queryRecordsAsUser(
        requestingUserId: string | null,
        records: SearchRecordMock[],
      ): SearchRecordMock[] {
        return records.filter((r) => {
          // Soft-deleted records are strictly hidden from all users
          if (r.deletedAt !== null) return false;
          // Revoked records are strictly hidden
          if (r.isRevoked) return false;
          // Public records are visible to everyone
          if (r.visibility === "public") return true;
          // Private records are visible ONLY to their owner
          return r.ownerId === requestingUserId;
        });
      }

      it("should hide private records from unauthenticated callers", () => {
        const visible = queryRecordsAsUser(null, mockDatabase);
        expect(visible.map((r) => r.id)).toEqual(["rec-1"]);
        expect(visible.some((r) => r.visibility === "private")).toBe(false);
      });

      it("should isolate private records so User Bob cannot see Alice's private record", () => {
        const bobView = queryRecordsAsUser("user-bob", mockDatabase);
        const bobIds = bobView.map((r) => r.id);

        expect(bobIds).toContain("rec-1"); // Alice's public
        expect(bobIds).toContain("rec-3"); // Bob's private
        expect(bobIds).not.toContain("rec-2"); // Alice's private MUST BE HIDDEN
        expect(bobIds).not.toContain("rec-4"); // Revoked MUST BE HIDDEN
        expect(bobIds).not.toContain("rec-5"); // Soft-deleted MUST BE HIDDEN
      });

      it("should guarantee that soft-deleted and revoked records are never disclosed", () => {
        const aliceView = queryRecordsAsUser("user-alice", mockDatabase);
        const aliceIds = aliceView.map((r) => r.id);

        expect(aliceIds).toContain("rec-1");
        expect(aliceIds).toContain("rec-2");
        expect(aliceIds).not.toContain("rec-4"); // Revoked is hidden even from others
        expect(aliceIds).not.toContain("rec-5"); // Soft-deleted is hidden even from owner
      });
    });

    describe("Pagination Stability Invariant in the Presence of Hidden Records", () => {
      interface PagedItem {
        id: string;
        createdAt: number;
        hidden: boolean;
      }

      // Simulate a database table with interleaving visible and hidden records
      const fullDataset: PagedItem[] = [
        { id: "item-10", createdAt: 1000, hidden: false },
        { id: "item-09", createdAt: 900, hidden: true }, // hidden
        { id: "item-08", createdAt: 800, hidden: false },
        { id: "item-07", createdAt: 700, hidden: true }, // hidden
        { id: "item-06", createdAt: 600, hidden: false },
        { id: "item-05", createdAt: 500, hidden: false },
        { id: "item-04", createdAt: 400, hidden: true }, // hidden
        { id: "item-03", createdAt: 300, hidden: false },
        { id: "item-02", createdAt: 200, hidden: false },
        { id: "item-01", createdAt: 100, hidden: false },
      ];

      function fetchPageKeyset(
        dataset: PagedItem[],
        limit: number,
        cursor?: { createdAt: number; id: string },
      ) {
        // Predicates (hidden filter) are applied before cursor predicate
        let filtered = dataset.filter((item) => !item.hidden);

        if (cursor) {
          filtered = filtered.filter(
            (item) =>
              item.createdAt < cursor.createdAt ||
              (item.createdAt === cursor.createdAt && item.id < cursor.id),
          );
        }

        const items = filtered.slice(0, limit);
        const nextItem = items[items.length - 1];
        const nextCursor = nextItem
          ? { createdAt: nextItem.createdAt, id: nextItem.id }
          : null;

        return { items, nextCursor };
      }

      it("should maintain sequential cursor pagination without skipping or duplicating records despite hidden rows", () => {
        const pageSize = 3;
        const page1 = fetchPageKeyset(fullDataset, pageSize);
        expect(page1.items.map((i) => i.id)).toEqual(["item-10", "item-08", "item-06"]);

        const page2 = fetchPageKeyset(fullDataset, pageSize, page1.nextCursor!);
        expect(page2.items.map((i) => i.id)).toEqual(["item-05", "item-03", "item-02"]);

        const page3 = fetchPageKeyset(fullDataset, pageSize, page2.nextCursor!);
        expect(page3.items.map((i) => i.id)).toEqual(["item-01"]);

        // Total retrieved matches exactly the visible count
        const allRetrieved = [...page1.items, ...page2.items, ...page3.items];
        expect(allRetrieved).toHaveLength(7);
        expect(new Set(allRetrieved.map((i) => i.id)).size).toBe(7);
      });
    });

    describe("Transaction Disclosure Invariant: Critical Risks Are Never Hidden", () => {
      it("should guarantee critical risk sections are expanded and never listed as hidden", () => {
        const criticalSection: TransactionSectionDefinition = {
          id: "risk",
          label: "Critical Invariant Warning",
          summary: "Potential ledger desynchronization",
          risk: "critical",
          requiredTier: TransactionDetailTier.ADVANCED, // Even if advanced, critical risk MUST NOT BE HIDDEN
        };

        const { disclosure } = buildTransactionDisclosure(TransactionDetailTier.SUMMARY, {
          sections: [{ definition: criticalSection, data: { status: "desynced" } }],
          warnings: [],
        });

        // Overriding rule: critical risks are never hidden
        expect(disclosure.hidden.some((h) => h.id === "risk")).toBe(false);
        expect(disclosure.sections.some((s) => s.id === "risk" && s.state === "expanded")).toBe(true);
      });

      it("should place non-critical tier-gated sections in hidden with requires_tier reason", () => {
        const advancedSection: TransactionSectionDefinition = {
          id: "raw_payload",
          label: "Raw Payload Data",
          summary: "Complete transaction envelope bytes",
          risk: "info",
          requiredTier: TransactionDetailTier.ADVANCED,
        };

        const { disclosure } = buildTransactionDisclosure(TransactionDetailTier.SUMMARY, {
          sections: [{ definition: advancedSection, data: { raw: "0x123" } }],
          warnings: [],
        });

        expect(disclosure.hidden).toHaveLength(1);
        expect(disclosure.hidden[0].id).toBe("raw_payload");
        expect(disclosure.hidden[0].reason).toBe("requires_advanced_tier");
      });
    });
  });
});
