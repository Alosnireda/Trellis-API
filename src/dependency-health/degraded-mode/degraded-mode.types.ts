/**
 * Types for dependency-health degraded-mode behaviour (issue #355).
 *
 * The dependency health check (issue #124) reports the state of every external
 * dependency. This slice turns that report into an actionable **operating
 * mode**: when a critical dependency is unhealthy the API does not simply fail
 * requests — it enters a defined degraded mode that disables the capabilities
 * that depend on the failing dependency and keeps the rest available.
 */

export type DegradedModeLevel = "normal" | "degraded" | "restricted" | "maintenance";

/** Coarse capabilities that can be independently disabled in a degraded mode. */
export type DegradedCapability =
  | "payments"
  | "trades"
  | "oracle"
  | "imports"
  | "exports"
  | "search"
  | "notifications"
  | "webhooks"
  | "admin";

export const ALL_DEGRADED_CAPABILITIES: DegradedCapability[] = [
  "payments",
  "trades",
  "oracle",
  "imports",
  "exports",
  "search",
  "notifications",
  "webhooks",
  "admin",
];

/** Maps a dependency id to the capabilities that cannot run without it. */
export type DependencyCapabilityMap = Record<string, DegradedCapability[]>;

export interface ManualDegradedModeInput {
  level: DegradedModeLevel;
  reason: string;
  disabledCapabilities?: DegradedCapability[];
}

export interface DegradedModeDecision {
  level: DegradedModeLevel;
  active: boolean;
  /** Capabilities that remain available. */
  allowedCapabilities: DegradedCapability[];
  /** Capabilities disabled because a dependency is unavailable/misconfigured. */
  disabledCapabilities: DegradedCapability[];
  /** Capabilities that still work but are expected to be slow or partial. */
  degradedCapabilities: DegradedCapability[];
  reasons: string[];
  criticalFindings: string[];
  advisoryFindings: string[];
  /** Whether a manual operator override is currently in force. */
  manualOverride: boolean;
  generatedAt: string;
}

/** Declares how a capability behaves when its dependencies are down (issue #412). */
export interface CapabilityFallback {
  /** What happens instead of the normal code path. */
  behavior: "queue_for_later" | "read_only" | "reject_with_503" | "serve_stale" | "manual_override";
  /** Operator-facing note surfaced in the degraded-mode decision. */
  note: string;
}

export interface DegradedModeCapabilityView {
  capability: DegradedCapability;
  state: "available" | "degraded" | "disabled";
  reason?: string;
}
