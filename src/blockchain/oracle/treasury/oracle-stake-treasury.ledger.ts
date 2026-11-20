/*
 * Off-chain projection of the oracle contract's stake treasury (#335).
 *
 * Folds decoded `staked`, `slashed`, `unbond` and `withdrawn` events (see
 * oracle-contract-events.ts) into per-submitter balances and enforces value
 * conservation: every unit that entered the contract is in exactly one place.
 *
 *   deposited = Σ bonded + Σ unbonding + treasury (slashed) + withdrawn
 *
 * Applying an event is atomic: it is validated against a copy of the affected
 * account and committed only if every check passes, so a rejected event
 * leaves the ledger byte-for-byte unchanged. Re-applying an event with the
 * same id and content is a no-op, which makes replaying a ledger range after
 * a crash safe. See docs/TREASURY_BALANCE_CONSERVATION.md.
 */

import { createHash } from "crypto";
import { canonicalJson } from "../../../common/serialization/canonical-json";
import { DecodedOracleEvent } from "../events/oracle-contract-events";

/** Event kinds that move value; every other oracle kind is ignored. */
export const STAKE_EVENT_KINDS = ["staked", "slashed", "unbond", "withdrawn"] as const;
export type StakeEventKind = (typeof STAKE_EVENT_KINDS)[number];

export type StakeLedgerErrorCode =
  | "UNAUTHORIZED_EMITTER"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BONDED"
  | "INSUFFICIENT_UNBONDING"
  | "REPORTED_BALANCE_MISMATCH"
  | "EVENT_ID_CONFLICT";

/**
 * An event the ledger refuses. None are retryable as-is: they indicate a
 * forged/foreign event, a gap in the applied history, or contract drift.
 */
export class StakeLedgerError extends Error {
  constructor(
    public readonly code: StakeLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StakeLedgerError";
  }
}

export interface StakeAccount {
  submitter: string;
  bonded: bigint;
  unbonding: bigint;
}

export interface TreasurySnapshot {
  deposited: bigint;
  withdrawn: bigint;
  /** Slashed penalties retained by the contract. */
  treasury: bigint;
  bonded: bigint;
  unbonding: bigint;
  appliedEvents: number;
  /** Sorted by submitter so snapshots compare deterministically. */
  accounts: StakeAccount[];
}

export type ApplyOutcome = "applied" | "duplicate" | "ignored";

export interface ConservationViolation {
  invariant: "conservation" | "nonnegative" | "aggregate_matches_accounts";
  detail: string;
}

function amount(event: DecodedOracleEvent, field: string): bigint {
  const raw = event.fields[field];
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw))
    throw new StakeLedgerError("INVALID_AMOUNT", `${event.kind}.${field} is not an integer`);
  return BigInt(raw);
}

function positive(event: DecodedOracleEvent, field: string): bigint {
  const value = amount(event, field);
  if (value <= 0n)
    throw new StakeLedgerError("INVALID_AMOUNT", `${event.kind}.${field} must be positive, got ${value}`);
  return value;
}

function digest(event: DecodedOracleEvent): string {
  return createHash("sha256")
    .update(canonicalJson({ kind: event.kind, contractId: event.contractId, fields: event.fields }))
    .digest("hex");
}

export class OracleStakeTreasuryLedger {
  private readonly accounts = new Map<string, StakeAccount>();
  private readonly applied = new Map<string, string>();
  private deposited = 0n;
  private withdrawn = 0n;
  private treasury = 0n;
  private bonded = 0n;
  private unbonding = 0n;

  /** @param contractId the configured oracle contract; other emitters are refused. */
  constructor(private readonly contractId: string) {}

  /**
   * Applies one decoded event identified by a stable `eventId` (e.g.
   * `<txHash>:<operation>:<index>`). Throws {@link StakeLedgerError} and
   * leaves state untouched if the event would break an invariant.
   */
  apply(eventId: string, event: DecodedOracleEvent): ApplyOutcome {
    if (event.contractId !== this.contractId)
      throw new StakeLedgerError(
        "UNAUTHORIZED_EMITTER",
        `Stake events are only trusted from ${this.contractId}, got ${event.contractId}`,
      );
    if (!(STAKE_EVENT_KINDS as readonly string[]).includes(event.kind)) return "ignored";

    const fingerprint = digest(event);
    const previous = this.applied.get(eventId);
    if (previous === fingerprint) return "duplicate";
    if (previous !== undefined)
      throw new StakeLedgerError(
        "EVENT_ID_CONFLICT",
        `Event ${eventId} was already applied with different content`,
      );

    const submitter = String(event.fields.submitter);
    const current = this.accounts.get(submitter) ?? { submitter, bonded: 0n, unbonding: 0n };
    const next = { ...current };
    const delta = { deposited: 0n, withdrawn: 0n, treasury: 0n };

    switch (event.kind as StakeEventKind) {
      case "staked": {
        const value = positive(event, "amount");
        next.bonded += value;
        delta.deposited = value;
        this.expectReported(event, "total_stake", next.bonded);
        break;
      }
      case "slashed": {
        const value = positive(event, "penalty_amount");
        if (value > next.bonded)
          throw new StakeLedgerError(
            "INSUFFICIENT_BONDED",
            `Slash of ${value} exceeds ${submitter}'s bonded ${next.bonded}`,
          );
        next.bonded -= value;
        delta.treasury = value;
        this.expectReported(event, "remaining_stake", next.bonded);
        break;
      }
      case "unbond": {
        const value = positive(event, "amount");
        if (value > next.bonded)
          throw new StakeLedgerError(
            "INSUFFICIENT_BONDED",
            `Unbond of ${value} exceeds ${submitter}'s bonded ${next.bonded}`,
          );
        next.bonded -= value;
        next.unbonding += value;
        break;
      }
      case "withdrawn": {
        const value = positive(event, "amount");
        if (value > next.unbonding)
          throw new StakeLedgerError(
            "INSUFFICIENT_UNBONDING",
            `Withdrawal of ${value} exceeds ${submitter}'s unbonding ${next.unbonding}`,
          );
        next.unbonding -= value;
        delta.withdrawn = value;
        break;
      }
    }

    // Commit: every check above has passed.
    this.bonded += next.bonded - current.bonded;
    this.unbonding += next.unbonding - current.unbonding;
    this.deposited += delta.deposited;
    this.withdrawn += delta.withdrawn;
    this.treasury += delta.treasury;
    this.accounts.set(submitter, next);
    this.applied.set(eventId, fingerprint);
    return "applied";
  }

  snapshot(): TreasurySnapshot {
    return {
      deposited: this.deposited,
      withdrawn: this.withdrawn,
      treasury: this.treasury,
      bonded: this.bonded,
      unbonding: this.unbonding,
      appliedEvents: this.applied.size,
      accounts: [...this.accounts.values()]
        .map((account) => ({ ...account }))
        .sort((a, b) => (a.submitter < b.submitter ? -1 : a.submitter > b.submitter ? 1 : 0)),
    };
  }

  /** Independent re-derivation of every invariant; empty when the ledger is sound. */
  checkInvariants(): ConservationViolation[] {
    const violations: ConservationViolation[] = [];
    let bonded = 0n;
    let unbonding = 0n;
    for (const account of this.accounts.values()) {
      if (account.bonded < 0n || account.unbonding < 0n)
        violations.push({
          invariant: "nonnegative",
          detail: `${account.submitter} has bonded ${account.bonded}, unbonding ${account.unbonding}`,
        });
      bonded += account.bonded;
      unbonding += account.unbonding;
    }
    if (bonded !== this.bonded || unbonding !== this.unbonding)
      violations.push({
        invariant: "aggregate_matches_accounts",
        detail: `aggregates bonded=${this.bonded} unbonding=${this.unbonding}; accounts sum to ${bonded}/${unbonding}`,
      });
    for (const [name, value] of Object.entries({
      deposited: this.deposited,
      withdrawn: this.withdrawn,
      treasury: this.treasury,
    }))
      if (value < 0n) violations.push({ invariant: "nonnegative", detail: `${name} is ${value}` });
    const held = bonded + unbonding + this.treasury + this.withdrawn;
    if (held !== this.deposited)
      violations.push({
        invariant: "conservation",
        detail: `deposited ${this.deposited} != bonded ${bonded} + unbonding ${unbonding} + treasury ${this.treasury} + withdrawn ${this.withdrawn}`,
      });
    return violations;
  }

  /**
   * The contract reports the submitter's post-event stake. A mismatch means
   * the projection missed or double-applied an event (or the contract
   * changed semantics), so the event is refused rather than silently drifting.
   */
  private expectReported(event: DecodedOracleEvent, field: string, expected: bigint): void {
    const reported = amount(event, field);
    if (reported !== expected)
      throw new StakeLedgerError(
        "REPORTED_BALANCE_MISMATCH",
        `${event.kind}.${field} reports ${reported}, projection has ${expected}`,
      );
  }
}
