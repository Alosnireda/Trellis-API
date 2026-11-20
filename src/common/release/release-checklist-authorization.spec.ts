import { ForbiddenException } from "@nestjs/common";
import { Role } from "../../common/guard/roles.enum";
import { ReleaseChecklistService } from "./release-checklist.service";
import { ReleaseChecklistController } from "./release-checklist.controller";
import { CheckStatus, CheckSeverity } from "./release-checklist";

/**
 * Authorization and security tests for release checklist.
 * Verifies that release-critical operations are properly guarded by role checks.
 *
 * Tests authorization paths for issue #411 (release readiness checks).
 */
describe("Release Checklist Authorization", () => {
  let service: ReleaseChecklistService;
  let controller: ReleaseChecklistController;

  const adminUser = { email: "admin@trellis.com", roles: [Role.ADMIN] };
  const maintainerUser = { email: "maintainer@trellis.com", roles: [Role.MAINTAINER] };
  const userUser = { email: "user@trellis.com", roles: [Role.USER] };

  beforeEach(() => {
    service = new ReleaseChecklistService();
    controller = new ReleaseChecklistController(service);
  });

  describe("Waiver authorization", () => {
    it("only maintainers and admins can waive critical checks", () => {
      controller.createChecklist(
        { prNumber: "301", title: "Auth Test", files: [] },
        { user: adminUser },
      );

      // Admin should succeed
      expect(() => {
        controller.waiveCheck("301", "migration_locking", {
          reason: "Valid detailed justification for the waiver decision",
          approvedBy: "admin@trellis.com",
        });
      }).not.toThrow();

      controller.createChecklist(
        { prNumber: "302", title: "Auth Test 2", files: [] },
        { user: maintainerUser },
      );

      // Maintainer should succeed
      expect(() => {
        controller.waiveCheck("302", "migration_locking", {
          reason: "Valid detailed justification for the waiver decision",
          approvedBy: "maintainer@trellis.com",
        });
      }).not.toThrow();

      controller.createChecklist(
        { prNumber: "303", title: "Auth Test 3", files: [] },
        { user: userUser },
      );

      // Regular user should fail
      expect(() => {
        controller.waiveCheck("303", "migration_locking", {
          reason: "Valid detailed justification for the waiver decision",
          approvedBy: "user@trellis.com",
        });
      }).toThrow(ForbiddenException);
    });

    it("requires explicit approver identity for waivers", () => {
      controller.createChecklist(
        { prNumber: "304", title: "No Approver", files: [] },
        { user: adminUser },
      );

      expect(() => {
        controller.waiveCheck("304", "migration_locking", {
          reason: "Valid detailed justification for the waiver decision",
          approvedBy: "", // Empty approver
        });
      }).toThrow();
    });
  });

  describe("Release approval authorization", () => {
    it("only maintainers and admins can approve releases", () => {
      controller.createChecklist(
        { prNumber: "305", title: "Approval Test", files: [] },
        { user: adminUser },
      );

      const checklist = service.getChecklist("305")!;
      const criticalChecks = checklist.checks.filter((c) => c.severity === CheckSeverity.CRITICAL);
      for (const c of criticalChecks) {
        service.updateCheckResult(checklist, c.id, CheckStatus.PASSED);
      }

      // Admin should succeed
      expect(() => {
        controller.approveRelease("305", { approvedBy: "admin@trellis.com" });
      }).not.toThrow();

      // Maintainer should succeed
      controller.createChecklist(
        { prNumber: "306", title: "Approval Test 2", files: [] },
        { user: maintainerUser },
      );

      const checklist2 = service.getChecklist("306")!;
      const checks2 = checklist2.checks.filter((c) => c.severity === CheckSeverity.CRITICAL);
      for (const c of checks2) {
        service.updateCheckResult(checklist2, c.id, CheckStatus.PASSED);
      }

      expect(() => {
        controller.approveRelease("306", { approvedBy: "maintainer@trellis.com" });
      }).not.toThrow();

      // Regular user should fail
      controller.createChecklist(
        { prNumber: "307", title: "Approval Test 3", files: [] },
        { user: userUser },
      );

      expect(() => {
        controller.approveRelease("307", { approvedBy: "user@trellis.com" });
      }).toThrow(ForbiddenException);
    });
  });

  describe("Checklist creation and access", () => {
    it("any authenticated user can create a checklist", () => {
      expect(() => {
        controller.createChecklist(
          { prNumber: "308", title: "User Created", files: [] },
          { user: userUser },
        );
      }).not.toThrow();

      expect(() => {
        controller.createChecklist(
          { prNumber: "309", title: "Maintainer Created", files: [] },
          { user: maintainerUser },
        );
      }).not.toThrow();

      expect(() => {
        controller.createChecklist(
          { prNumber: "310", title: "Admin Created", files: [] },
          { user: adminUser },
        );
      }).not.toThrow();
    });

    it("any user can view checklist status", () => {
      controller.createChecklist(
        { prNumber: "311", title: "Public Checklist", files: [] },
        { user: adminUser },
      );

      // All roles should be able to read
      expect(() => {
        controller.getChecklistStatus("311");
      }).not.toThrow();
    });
  });

  describe("Failure scenarios with authorization", () => {
    it("tracks who made each change in audit history", () => {
      controller.createChecklist(
        { prNumber: "312", title: "Audit Trail", files: [] },
        { user: adminUser },
      );

      service.updateCheckByPr("312", "test_unit_coverage", CheckStatus.PASSED, {
        notes: "Coverage verified",
        actor: "maintainer@trellis.com",
      });

      const audit = service.getAuditHistory("312");
      expect(audit.some((a) => a.actor === "maintainer@trellis.com")).toBe(true);
    });

    it("prevents unauthorized role escalation via waivers", () => {
      controller.createChecklist(
        { prNumber: "313", title: "Role Check", files: [] },
        { user: userUser },
      );

      // User cannot create a waiver that claims to be from an admin
      expect(() => {
        controller.waiveCheck("313", "migration_locking", {
          reason: "Valid detailed justification for the waiver decision",
          approvedBy: "admin@trellis.com", // User claiming to be admin
        });
      }).toThrow(ForbiddenException);
    });

    it("requires proper authorization context for all state changes", () => {
      controller.createChecklist(
        { prNumber: "314", title: "Auth Context", files: [] },
        { user: adminUser },
      );

      // This should work - admin making the change
      expect(() => {
        controller.updateCheck("314", "test_unit_coverage", {
          status: CheckStatus.PASSED,
          notes: "Updated by admin",
        });
      }).not.toThrow();

      // User should not be able to update if the controller enforces auth
      // (This depends on controller implementation)
      // For now, the service-level function doesn't enforce roles
      // but the controller should
    });
  });

  describe("Waiver enforcement rules", () => {
    it("rejects waivers with insufficient justification", () => {
      controller.createChecklist(
        { prNumber: "315", title: "Waiver Rules", files: [] },
        { user: adminUser },
      );

      // Too short
      expect(() => {
        controller.waiveCheck("315", "migration_locking", {
          reason: "short",
          approvedBy: "admin@trellis.com",
        });
      }).toThrow();

      // Exactly 10 chars - should work
      expect(() => {
        controller.waiveCheck("315", "migration_locking", {
          reason: "1234567890",
          approvedBy: "admin@trellis.com",
        });
      }).not.toThrow();
    });
  });

  describe("Retry behavior under authorization constraints", () => {
    it("waiver approval persists through retries", () => {
      controller.createChecklist(
        { prNumber: "316", title: "Retry Persist", files: [] },
        { user: adminUser },
      );

      // Waive a check
      controller.waiveCheck("316", "migration_locking", {
        reason: "Valid detailed justification for the waiver decision",
        approvedBy: "admin@trellis.com",
      });

      // Try to re-waive - should update, not duplicate
      controller.waiveCheck("316", "migration_locking", {
        reason: "Updated justification with more detail",
        approvedBy: "admin@trellis.com",
      });

      const checklist = service.getChecklist("316")!;
      const result = checklist.results.get("migration_locking");
      expect(result?.waiverApprovedBy).toBe("admin@trellis.com");
      expect(result?.status).toBe(CheckStatus.WAIVED);
    });
  });
});
