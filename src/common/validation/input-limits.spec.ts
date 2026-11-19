import { BadRequestException, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  validatePayloadLimits,
  validateQueryParamsCardinality,
  DEFAULT_INPUT_LIMITS,
} from "./input-limits.validator";
import { InputLimitsPipe } from "../pipes/input-limits.pipe";
import { InputLimitsGuard } from "../guard/input-limits.guard";
import { Role } from "../guard/roles.enum";

describe("Strict Input Size and Cardinality Limits (#437)", () => {
  describe("Core Limits Validator: validatePayloadLimits", () => {
    describe("Normal Path", () => {
      it("should accept valid payload within default limits", () => {
        const payload = {
          name: "Stellar Portfolio Alpha",
          assets: [
            { code: "XLM", balance: "100.0000000" },
            { code: "USDC", balance: "500.0000000" },
          ],
          metadata: {
            strategy: "yield-maximizer",
            tags: ["stellar", "soroban", "defi"],
          },
        };

        const result = validatePayloadLimits(payload);

        expect(result.valid).toBe(true);
        expect(result.violations).toHaveLength(0);
        expect(result.metrics.maxObservedDepth).toBeLessThanOrEqual(DEFAULT_INPUT_LIMITS.maxDepth);
        expect(result.metrics.totalKeysCount).toBeLessThanOrEqual(DEFAULT_INPUT_LIMITS.maxTotalKeys);
      });

      it("should handle null, undefined, and non-object primitives gracefully", () => {
        expect(validatePayloadLimits(null).valid).toBe(true);
        expect(validatePayloadLimits(undefined).valid).toBe(true);
        expect(validatePayloadLimits(12345).valid).toBe(true);
        expect(validatePayloadLimits(true).valid).toBe(true);
      });
    });

    describe("Failure Path: Cardinality & Depth Violations", () => {
      it("should reject deeply nested objects exceeding maxDepth (recursion bomb)", () => {
        // Construct an object nested 15 levels deep
        let deepObj: any = { value: "leaf" };
        for (let i = 0; i < 15; i++) {
          deepObj = { level: i, child: deepObj };
        }

        const result = validatePayloadLimits(deepObj, { maxDepth: 10 });

        expect(result.valid).toBe(false);
        const depthViolation = result.violations.find((v) => v.code === "INPUT_DEPTH_EXCEEDED");
        expect(depthViolation).toBeDefined();
        expect(depthViolation!.actual).toBeGreaterThan(10);
      });

      it("should reject objects with excessive property cardinality (Hash-DoS prevention)", () => {
        const wideObject: Record<string, number> = {};
        for (let i = 0; i < 150; i++) {
          wideObject[`dynamic_key_${i}`] = i;
        }

        const result = validatePayloadLimits(wideObject, { maxObjectKeys: 100 });

        expect(result.valid).toBe(false);
        const cardViolation = result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED");
        expect(cardViolation).toBeDefined();
        expect(cardViolation!.actual).toBe(150);
        expect(cardViolation!.limit).toBe(100);
      });

      it("should reject arrays exceeding maxArrayLength", () => {
        const largeArray = new Array(1500).fill("sample-item");

        const result = validatePayloadLimits({ items: largeArray }, { maxArrayLength: 1000 });

        expect(result.valid).toBe(false);
        const arrayViolation = result.violations.find((v) => v.code === "INPUT_CARDINALITY_EXCEEDED");
        expect(arrayViolation).toBeDefined();
        expect(arrayViolation!.actual).toBe(1500);
      });

      it("should reject strings exceeding maxStringLength", () => {
        const hugeString = "A".repeat(70000); // 70KB

        const result = validatePayloadLimits({ payload: hugeString }, { maxStringLength: 65536 });

        expect(result.valid).toBe(false);
        const sizeViolation = result.violations.find((v) => v.code === "INPUT_SIZE_EXCEEDED");
        expect(sizeViolation).toBeDefined();
        expect(sizeViolation!.actual).toBe(70000);
      });

      it("should reject payloads exceeding cumulative maxTotalKeys", () => {
        // Multiple objects that together exceed 500 keys
        const container: any = {};
        for (let objIndex = 0; objIndex < 10; objIndex++) {
          const subObj: any = {};
          for (let keyIndex = 0; keyIndex < 60; keyIndex++) {
            subObj[`sub_${keyIndex}`] = keyIndex;
          }
          container[`obj_${objIndex}`] = subObj;
        }

        const result = validatePayloadLimits(container, { maxTotalKeys: 500 });

        expect(result.valid).toBe(false);
        expect(result.violations.some((v) => v.message.includes("Total payload keys count"))).toBe(true);
      });
    });

    describe("Query Parameter Cardinality", () => {
      it("should allow query params within cardinality limit", () => {
        const query = { page: "1", limit: "20", sort: "asc" };
        expect(validateQueryParamsCardinality(query, 50)).toBeNull();
      });

      it("should reject query params exceeding cardinality limit", () => {
        const query: Record<string, string> = {};
        for (let i = 0; i < 60; i++) {
          query[`filter_${i}`] = `value_${i}`;
        }

        const violation = validateQueryParamsCardinality(query, 50);

        expect(violation).not.toBeNull();
        expect(violation!.code).toBe("QUERY_CARDINALITY_EXCEEDED");
        expect(violation!.actual).toBe(60);
      });
    });
  });

  describe("InputLimitsPipe", () => {
    let pipe: InputLimitsPipe;

    beforeEach(() => {
      pipe = new InputLimitsPipe({ maxDepth: 5, maxObjectKeys: 50 });
    });

    it("should pass valid payloads through unchanged", () => {
      const payload = { valid: true, count: 10 };
      expect(pipe.transform(payload, { type: "body" })).toBe(payload);
    });

    it("should throw BadRequestException with RFC 7807 error details on limit violation", () => {
      const oversizedPayload: any = {};
      for (let i = 0; i < 60; i++) {
        oversizedPayload[`prop_${i}`] = i;
      }

      expect(() => {
        pipe.transform(oversizedPayload, { type: "body" });
      }).toThrow(BadRequestException);

      try {
        pipe.transform(oversizedPayload, { type: "body" });
      } catch (err: any) {
        const response = err.getResponse();
        expect(response.statusCode).toBe(400);
        expect(response.code).toBe("INPUT_CARDINALITY_EXCEEDED");
        expect(response.violations.length).toBeGreaterThan(0);
        expect(response.remediation).toBeDefined();
      }
    });
  });

  describe("InputLimitsGuard & Authorization Path", () => {
    let guard: InputLimitsGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new InputLimitsGuard(reflector);
    });

    function createMockContext(body: any, query: any, roles: string[] = []): ExecutionContext {
      return {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({
            body,
            query,
            user: { roles },
          }),
        }),
      } as unknown as ExecutionContext;
    }

    it("should allow normal user within baseline limits", () => {
      const context = createMockContext({ title: "Normal" }, { page: "1" }, [Role.USER]);
      expect(guard.canActivate(context)).toBe(true);
    });

    it("should reject standard user exceeding baseline limits", () => {
      const largeArray = new Array(1500).fill(1);
      const context = createMockContext({ items: largeArray }, {}, [Role.USER]);

      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });

    it("should grant elevated capacity ceiling to ADMIN and OPERATOR roles", () => {
      // 3000 items exceeds default 1000 limit, but within ADMIN elevated 5000 ceiling
      const bulkArray = new Array(3000).fill(1);
      const context = createMockContext({ items: bulkArray }, {}, [Role.ADMIN]);

      expect(guard.canActivate(context)).toBe(true);
    });

    it("should reject request with excessive query parameters", () => {
      const queryParams: Record<string, string> = {};
      for (let i = 0; i < 75; i++) {
        queryParams[`param_${i}`] = "val";
      }

      const context = createMockContext({}, queryParams, [Role.USER]);

      expect(() => guard.canActivate(context)).toThrow(BadRequestException);
    });
  });
});

