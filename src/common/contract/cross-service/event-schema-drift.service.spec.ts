import {
  EventDriftAuthorizationError,
  EventSchemaDriftService,
} from "./event-schema-drift.service";
import { CROSS_SERVICE_EVENT_DEFINITIONS } from "./cross-service-contract-map.registry";
import { DomainEventContractDefinition } from "./cross-service-contract-map.types";

function cloneDefs(): DomainEventContractDefinition[] {
  return JSON.parse(JSON.stringify(CROSS_SERVICE_EVENT_DEFINITIONS));
}

describe("EventSchemaDriftService (issue #438)", () => {
  let service: EventSchemaDriftService;

  beforeEach(() => {
    service = new EventSchemaDriftService();
  });

  describe("Normal Path", () => {
    it("should report ok=true with zero breaking findings when baseline matches registry", () => {
      const report = service.checkBaselineDrift(cloneDefs());
      expect(report.ok).toBe(true);
      expect(report.breakingCount).toBe(0);
      expect(report.informationalCount).toBe(0);
      expect(report.totalCurrentEvents).toBe(CROSS_SERVICE_EVENT_DEFINITIONS.length);
    });

    it("should validate a conforming runtime event payload", () => {
      const result = service.validateEventPayload("auth.user.authenticated", {
        userId: "user-123",
        authMethod: "webauthn",
        ipAddress: "127.0.0.1",
        sessionId: "sess-1",
        authenticatedAt: new Date().toISOString(),
        mfaVerified: true,
      });

      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
      expect(result.typeMismatches).toEqual([]);
    });
  });

  describe("Failure Path", () => {
    it("should detect breaking drift when required fields are removed without major bump", () => {
      const current = cloneDefs();
      const target = current.find((d) => d.eventName === "auth.user.authenticated")!;
      target.requiredFields = ["userId"];

      const report = service.checkBaselineDrift(cloneDefs(), current);
      expect(report.ok).toBe(false);
      expect(report.breakingCount).toBeGreaterThan(0);
    });

    it("should detect runtime payload drift for missing required fields and type mismatches", () => {
      const result = service.validateEventPayload("auth.user.authenticated", {
        userId: 12345,
        authMethod: "password",
      });

      expect(result.valid).toBe(false);
      expect(result.missingFields).toEqual(
        expect.arrayContaining(["ipAddress", "sessionId", "authenticatedAt"]),
      );
      expect(result.typeMismatches).toEqual([
        expect.objectContaining({ field: "userId", actual: "number" }),
      ]);
    });

    it("should fail on unregistered event names", () => {
      const result = service.validateEventPayload("unknown.event.fired", {});
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Unregistered cross-service event");
    });
  });

  describe("Retry Path", () => {
    it("should recover when baseline loader experiences transient failures within maxRetries", async () => {
      let calls = 0;
      const report = await service.checkBaselineWithRetry(
        async () => {
          calls += 1;
          if (calls < 3) {
            throw new Error("ECONNRESET: temporary registry timeout");
          }
          return cloneDefs();
        },
        { maxRetries: 2 },
      );

      expect(report.ok).toBe(true);
      expect(report.attempts).toBe(3);
    });

    it("should throw after exhausting retries on persistent baseline loader failure", async () => {
      await expect(
        service.checkBaselineWithRetry(
          async () => {
            throw new Error("503 Service Unavailable");
          },
          { maxRetries: 1 },
        ),
      ).rejects.toThrow("Failed to load event schema baseline after 2 attempt(s)");
    });
  });

  describe("Authorization Path", () => {
    it("should allow admin, maintainer, or contracts:write scope to mutate baselines", () => {
      expect(() =>
        service.assertAuthorizedBaselineMutation({
          actorId: "usr-admin",
          role: "admin",
        }),
      ).not.toThrow();

      expect(() =>
        service.assertAuthorizedBaselineMutation({
          actorId: "ci-bot",
          role: "service",
          scopes: ["contracts:write"],
        }),
      ).not.toThrow();
    });

    it("should forbid unauthorized or missing actors from mutating baselines", () => {
      expect(() => service.assertAuthorizedBaselineMutation(undefined)).toThrow(
        EventDriftAuthorizationError,
      );

      expect(() =>
        service.assertAuthorizedBaselineMutation({
          actorId: "usr-viewer",
          role: "viewer",
        }),
      ).toThrow(EventDriftAuthorizationError);
    });
  });
});
