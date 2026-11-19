import { NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { SKIP_KYC_KEY } from "../decorators/skip-kyc.decorator";
import { ErrorCode } from "./error-codes";
import { ErrorCatalogController } from "./error-catalog.controller";
import { REMEDIATION_HINTS } from "./remediation-hints";

describe("ErrorCatalogController", () => {
  let controller: ErrorCatalogController;
  let reflector: Reflector;

  beforeEach(() => {
    controller = new ErrorCatalogController();
    reflector = new Reflector();
  });

  describe("Normal Path", () => {
    it("returns the complete catalog containing all defined ErrorCodes", () => {
      const result = controller.getCatalog();
      const allCodes = Object.values(ErrorCode);

      expect(result.total).toBe(allCodes.length);
      expect(result.catalog).toHaveLength(allCodes.length);

      const returnedCodes = result.catalog.map((item) => item.code);
      for (const code of allCodes) {
        expect(returnedCodes).toContain(code);
      }
    });

    it("ensures each catalog item includes well-structured taxonomy and remediation metadata", () => {
      const { catalog } = controller.getCatalog();

      for (const item of catalog) {
        expect(item.code).toBeDefined();
        expect(item.domain).toBeTruthy();
        expect(item.defaultMessage).toBeTruthy();
        expect(item.recoveryGuidance).toBeTruthy();
        expect(item.remediationHint).toBeDefined();
        expect(typeof item.retryable).toBe("boolean");
        expect(item.retryStrategy).toBeTruthy();
      }
    });

    it("returns specific error remediation item for a valid code in standard case", () => {
      const item = controller.getErrorHint("SETTLEMENT_TIMEOUT");

      expect(item.code).toBe(ErrorCode.SETTLEMENT_TIMEOUT);
      expect(item.domain).toBe("settlement");
      expect(item.retryable).toBe(true);
      expect(item.remediationHint.action).toContain("Verify transaction confirmation status");
      expect(item.remediationHint.steps.length).toBeGreaterThan(0);
      expect(item.remediationHint.docUrl).toContain("SETTLEMENT_TIMEOUT");
    });

    it("normalizes lowercase and whitespace-padded code inputs", () => {
      const lowerItem = controller.getErrorHint("settlement_timeout");
      expect(lowerItem.code).toBe(ErrorCode.SETTLEMENT_TIMEOUT);

      const paddedItem = controller.getErrorHint("  validation_error  ");
      expect(paddedItem.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe("Failure Path", () => {
    it("throws NotFoundException when querying an unknown error code", () => {
      expect(() => controller.getErrorHint("NON_EXISTENT_CODE_XYZ")).toThrow(NotFoundException);
      expect(() => controller.getErrorHint("NON_EXISTENT_CODE_XYZ")).toThrow(
        "Error code 'NON_EXISTENT_CODE_XYZ' not found in catalog.",
      );
    });

    it("throws NotFoundException when querying an empty or whitespace string", () => {
      expect(() => controller.getErrorHint("")).toThrow(NotFoundException);
      expect(() => controller.getErrorHint("   ")).toThrow(NotFoundException);
    });
  });

  describe("Retry Path", () => {
    it("differentiates retryable errors with positive retry-after duration and cool-off steps", () => {
      const retryableCodes = [
        ErrorCode.RATE_LIMITED,
        ErrorCode.SERVICE_UNAVAILABLE,
        ErrorCode.SETTLEMENT_TIMEOUT,
        ErrorCode.DEPENDENCY_TIMEOUT,
        ErrorCode.HORIZON_TIMEOUT,
        ErrorCode.STELLAR_NETWORK_ERROR,
      ];

      for (const code of retryableCodes) {
        const item = controller.getErrorHint(code);
        expect(item.retryable).toBe(true);
        expect(item.remediationHint.retryable).toBe(true);
        expect(item.remediationHint.retryAfterSeconds).toBeGreaterThan(0);
        expect(item.retryStrategy).not.toBe("none");
      }
    });

    it("marks non-retryable terminal errors with retryable: false and retryStrategy: none to avoid retry storms", () => {
      const terminalCodes = [
        ErrorCode.VALIDATION_ERROR,
        ErrorCode.MALFORMED_PAYLOAD,
        ErrorCode.INVALID_PARAMETER,
        ErrorCode.INVALID_CREDENTIALS,
        ErrorCode.UNAUTHORIZED,
        ErrorCode.FORBIDDEN,
      ];

      for (const code of terminalCodes) {
        const item = controller.getErrorHint(code);
        expect(item.retryable).toBe(false);
        expect(item.remediationHint.retryable).toBe(false);
        expect(item.retryStrategy).toBe("none");
      }
    });
  });

  describe("Authorization Path", () => {
    it("is decorated with @Public() so clients can fetch the catalog unauthenticated", () => {
      const isPublic = reflector.get<boolean>(IS_PUBLIC_KEY, ErrorCatalogController);
      expect(isPublic).toBe(true);
    });

    it("is decorated with @SkipKyc() to allow onboarding and unverified users access to error guidance", () => {
      const skipKyc = reflector.get(SKIP_KYC_KEY, ErrorCatalogController);
      expect(skipKyc).toBeDefined();
    });

    it("provides remediation hints for authorization failure error codes (UNAUTHORIZED & FORBIDDEN)", () => {
      const unauth = controller.getErrorHint(ErrorCode.UNAUTHORIZED);
      expect(unauth.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(unauth.remediationHint.action).toContain("Provide valid authentication");
      expect(unauth.retryable).toBe(false);

      const forbidden = controller.getErrorHint(ErrorCode.FORBIDDEN);
      expect(forbidden.code).toBe(ErrorCode.FORBIDDEN);
      expect(forbidden.remediationHint.action).toContain("Request required roles or permissions");
      expect(forbidden.retryable).toBe(false);
    });
  });
});
