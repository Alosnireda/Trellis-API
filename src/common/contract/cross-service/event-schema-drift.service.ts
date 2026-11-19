/**
 * @file event-schema-drift.service.ts
 *
 * Cross-service event schema drift detection service (issue #438).
 * Wraps `detectContractDrift` with retryable baseline loading, runtime payload
 * drift validation, and role/scope authorization for baseline updates.
 */

import { DomainEventContractDefinition } from "./cross-service-contract-map.types";
import { CROSS_SERVICE_EVENT_DEFINITIONS } from "./cross-service-contract-map.registry";
import {
  ContractDriftFinding,
  detectContractDrift,
} from "./cross-service-contract-drift";

export interface DriftActorContext {
  actorId: string;
  role: string;
  scopes?: string[];
}

export interface EventSchemaDriftReport {
  ok: boolean;
  checkedAt: string;
  totalBaselineEvents: number;
  totalCurrentEvents: number;
  breakingCount: number;
  informationalCount: number;
  attempts: number;
  findings: ContractDriftFinding[];
}

export interface PayloadValidationResult {
  valid: boolean;
  eventName: string;
  missingFields: string[];
  typeMismatches: Array<{ field: string; expected: string; actual: string }>;
  reason?: string;
}

export class EventDriftAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDriftAuthorizationError";
  }
}

const AUTHORIZED_ROLES = new Set(["admin", "maintainer", "platform-engineer"]);

export class EventSchemaDriftService {
  /**
   * Synchronously compares a baseline snapshot against current definitions.
   */
  checkBaselineDrift(
    baseline: DomainEventContractDefinition[],
    current: DomainEventContractDefinition[] = CROSS_SERVICE_EVENT_DEFINITIONS,
    attempts = 1,
  ): EventSchemaDriftReport {
    const report = detectContractDrift(baseline, current);
    const breakingCount = report.findings.filter((f) => f.breaking).length;
    return {
      ok: report.ok,
      checkedAt: new Date().toISOString(),
      totalBaselineEvents: baseline.length,
      totalCurrentEvents: current.length,
      breakingCount,
      informationalCount: report.findings.length - breakingCount,
      attempts,
      findings: report.findings,
    };
  }

  /**
   * Loads a remote or disk baseline with bounded retries and evaluates drift.
   */
  async checkBaselineWithRetry(
    loadBaseline: () => Promise<DomainEventContractDefinition[]>,
    options: {
      current?: DomainEventContractDefinition[];
      maxRetries?: number;
      retryDelayMs?: number;
    } = {},
  ): Promise<EventSchemaDriftReport> {
    const maxRetries = Math.max(0, options.maxRetries ?? 2);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    let attempts = 0;
    let lastError: unknown;

    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const baseline = await loadBaseline();
        return this.checkBaselineDrift(
          baseline,
          options.current ?? CROSS_SERVICE_EVENT_DEFINITIONS,
          attempts,
        );
      } catch (err) {
        lastError = err;
        if (attempts <= maxRetries && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Failed to load event schema baseline after ${attempts} attempt(s): ${message}`,
    );
  }

  /**
   * Validates an emitted event payload against the registered contract schema
   * to catch runtime producer drift.
   */
  validateEventPayload(
    eventName: string,
    payload: Record<string, unknown>,
    definitions: DomainEventContractDefinition[] = CROSS_SERVICE_EVENT_DEFINITIONS,
  ): PayloadValidationResult {
    const def = definitions.find((d) => d.eventName === eventName);
    if (!def) {
      return {
        valid: false,
        eventName,
        missingFields: [],
        typeMismatches: [],
        reason: `Unregistered cross-service event '${eventName}'`,
      };
    }

    const missingFields = def.requiredFields.filter(
      (field) => payload[field] === undefined || payload[field] === null,
    );

    const typeMismatches: Array<{
      field: string;
      expected: string;
      actual: string;
    }> = [];

    for (const [field, expectedSpec] of Object.entries(def.payloadSchema)) {
      const value = payload[field];
      if (value === undefined || value === null) continue;
      const expectedLower = expectedSpec.toLowerCase();
      const actualType = Array.isArray(value) ? "array" : typeof value;

      if (expectedLower.startsWith("string") && actualType !== "string") {
        typeMismatches.push({ field, expected: expectedSpec, actual: actualType });
      } else if (expectedLower.startsWith("number") && actualType !== "number") {
        typeMismatches.push({ field, expected: expectedSpec, actual: actualType });
      } else if (expectedLower.startsWith("boolean") && actualType !== "boolean") {
        typeMismatches.push({ field, expected: expectedSpec, actual: actualType });
      } else if (expectedLower.startsWith("array") && actualType !== "array") {
        typeMismatches.push({ field, expected: expectedSpec, actual: actualType });
      }
    }

    return {
      valid: missingFields.length === 0 && typeMismatches.length === 0,
      eventName,
      missingFields,
      typeMismatches,
    };
  }

  /**
   * Authorizes baseline snapshot updates or breaking-drift acknowledgements.
   */
  assertAuthorizedBaselineMutation(actor?: DriftActorContext): void {
    if (!actor || !actor.actorId) {
      throw new EventDriftAuthorizationError(
        "Missing actor context for event schema baseline mutation.",
      );
    }

    const hasRole = AUTHORIZED_ROLES.has(actor.role.toLowerCase());
    const hasScope = actor.scopes?.includes("contracts:write") ?? false;

    if (!hasRole && !hasScope) {
      throw new EventDriftAuthorizationError(
        `Actor '${actor.actorId}' with role '${actor.role}' is not authorized to mutate event schema baselines.`,
      );
    }
  }
}
