import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { mulberry32, PRNG } from "../../../testing/property-test-harness";
import {
  DecodedOracleEvent,
  decodeOracleContractEvent,
} from "../events/oracle-contract-events";
import {
  OracleStakeTreasuryLedger,
  StakeLedgerError,
  TreasurySnapshot,
} from "./oracle-stake-treasury.ledger";

/*
 * Treasury balance conservation invariants (#335).
 *
 * Seeded, reproducible random histories are driven through the ledger; after
 * every step the conservation identity, nonnegativity and aggregate/account
 * agreement must hold. Invalid events (failure path), duplicate deliveries
 * (retry path) and foreign emitters (authorization path) are interleaved.
 * A failing seed is printed so it can be replayed exactly.
 */

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const FOREIGN = StrKey.encodeContract(Buffer.alloc(32, 9));
const SUBMITTERS = [1, 2, 3, 4].map((n) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey());
const SEEDS = Array.from({ length: 25 }, (_, i) => 0x335 + i * 7919);
const STEPS = 120;

function event(kind: string, fields: Record<string, string>, contractId = CONTRACT): DecodedOracleEvent {
  return {
    status: "decoded",
    kind,
    schemaVersion: 1,
    contractId,
    fields: { ...fields, timestamp: "1" },
    correlationId: null,
    unknownTrailingFields: 0,
  };
}

/** Independent reference model: plain numbers per submitter. */
class Model {
  bonded = new Map<string, bigint>();
  unbonding = new Map<string, bigint>();
  get = (m: Map<string, bigint>, s: string) => m.get(s) ?? 0n;
}

function randomAmount(prng: PRNG, max: bigint): bigint {
  // Mix tiny, typical and i128-scale values so overflow-adjacent sums are exercised.
  const scale = [1n, 10_000_000n, 10n ** 30n][Math.floor(prng() * 3)];
  const value = BigInt(Math.floor(prng() * 1000) + 1) * scale;
  return max > 0n && value > max ? max : value;
}

/** Produces the next valid event for the model, or null if none applies. */
function validStep(prng: PRNG, model: Model): DecodedOracleEvent {
  const submitter = SUBMITTERS[Math.floor(prng() * SUBMITTERS.length)];
  const bonded = model.get(model.bonded, submitter);
  const unbonding = model.get(model.unbonding, submitter);
  const roll = prng();
  if (roll < 0.15 && bonded > 0n) {
    const penalty = randomAmount(prng, bonded);
    model.bonded.set(submitter, bonded - penalty);
    return event("slashed", {
      submitter,
      penalty_amount: String(penalty),
      remaining_stake: String(bonded - penalty),
      reason: "stale",
    });
  }
  if (roll < 0.35 && bonded > 0n) {
    const value = randomAmount(prng, bonded);
    model.bonded.set(submitter, bonded - value);
    model.unbonding.set(submitter, unbonding + value);
    return event("unbond", { submitter, amount: String(value), unlock_time: "100" });
  }
  if (roll < 0.5 && unbonding > 0n) {
    const value = randomAmount(prng, unbonding);
    model.unbonding.set(submitter, unbonding - value);
    return event("withdrawn", { submitter, amount: String(value) });
  }
  const value = randomAmount(prng, 0n);
  model.bonded.set(submitter, bonded + value);
  return event("staked", { submitter, amount: String(value), total_stake: String(bonded + value) });
}

/** An event the ledger must refuse given the current state. */
function invalidStep(prng: PRNG, ledger: OracleStakeTreasuryLedger): DecodedOracleEvent {
  const submitter = SUBMITTERS[Math.floor(prng() * SUBMITTERS.length)];
  const account = ledger.snapshot().accounts.find((a) => a.submitter === submitter);
  const bonded = account?.bonded ?? 0n;
  const unbonding = account?.unbonding ?? 0n;
  const options = [
    event("unbond", { submitter, amount: String(bonded + 1n), unlock_time: "1" }),
    event("withdrawn", { submitter, amount: String(unbonding + 1n) }),
    event("slashed", {
      submitter,
      penalty_amount: String(bonded + 1n),
      remaining_stake: "0",
      reason: "x",
    }),
    event("staked", { submitter, amount: "5", total_stake: String(bonded + 6n) }),
    event("staked", { submitter, amount: "0", total_stake: String(bonded) }),
    event("staked", { submitter, amount: "-5", total_stake: String(bonded - 5n) }),
    event("staked", { submitter, amount: "5", total_stake: String(bonded + 5n) }, FOREIGN),
  ];
  return options[Math.floor(prng() * options.length)];
}

function expectSound(ledger: OracleStakeTreasuryLedger, context: string) {
  const violations = ledger.checkInvariants();
  if (violations.length) throw new Error(`${context}: ${JSON.stringify(violations)}`);
  const s = ledger.snapshot();
  expect(s.bonded + s.unbonding + s.treasury + s.withdrawn).toBe(s.deposited);
}

describe("oracle stake treasury conservation invariants (#335)", () => {
  describe.each(SEEDS)("seed %i", (seed) => {
    it("conserves value across a random history with failures, retries and foreign events", () => {
      const prng = mulberry32(seed);
      const model = new Model();
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      const history: Array<[string, DecodedOracleEvent]> = [];

      for (let step = 0; step < STEPS; step++) {
        const context = `seed=${seed} step=${step}`;
        const roll = prng();
        if (roll < 0.15) {
          // Failure / authorization path: refused atomically.
          const before = ledger.snapshot();
          expect(() => ledger.apply(`bad-${step}`, invalidStep(prng, ledger))).toThrow(StakeLedgerError);
          expect(ledger.snapshot()).toEqual(before);
        } else if (roll < 0.25 && history.length) {
          // Retry path: a redelivered event is a no-op.
          const [id, previous] = history[Math.floor(prng() * history.length)];
          const before = ledger.snapshot();
          expect(ledger.apply(id, previous)).toBe("duplicate");
          expect(ledger.snapshot()).toEqual(before);
        } else {
          const next = validStep(prng, model);
          const id = `tx-${step}:0:0`;
          expect(ledger.apply(id, next)).toBe("applied");
          history.push([id, next]);
        }
        expectSound(ledger, context);
      }

      // The projection agrees with the independent model per submitter.
      for (const account of ledger.snapshot().accounts) {
        expect(account.bonded).toBe(model.get(model.bonded, account.submitter));
        expect(account.unbonding).toBe(model.get(model.unbonding, account.submitter));
      }

      // Rebuild (recovery path): replaying the applied history into a fresh
      // ledger, with every event delivered twice, reproduces the same state.
      const rebuilt = new OracleStakeTreasuryLedger(CONTRACT);
      for (const [id, e] of history) {
        rebuilt.apply(id, e);
        rebuilt.apply(id, e);
      }
      expect(rebuilt.snapshot()).toEqual(ledger.snapshot());
    });
  });

  describe("normal path", () => {
    it("tracks a full stake → slash → unbond → withdraw lifecycle", () => {
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      const [s] = SUBMITTERS;
      ledger.apply("1", event("staked", { submitter: s, amount: "1000", total_stake: "1000" }));
      ledger.apply("2", event("slashed", { submitter: s, penalty_amount: "100", remaining_stake: "900", reason: "stale" }));
      ledger.apply("3", event("unbond", { submitter: s, amount: "400", unlock_time: "9" }));
      ledger.apply("4", event("withdrawn", { submitter: s, amount: "250" }));
      expect(ledger.snapshot()).toEqual<TreasurySnapshot>({
        deposited: 1000n,
        withdrawn: 250n,
        treasury: 100n,
        bonded: 500n,
        unbonding: 150n,
        appliedEvents: 4,
        accounts: [{ submitter: s, bonded: 500n, unbonding: 150n }],
      });
      expect(ledger.checkInvariants()).toEqual([]);
    });

    it("ignores non-stake oracle events", () => {
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      expect(ledger.apply("p", event("price", { feed_id: "XLM", price: "5", submitter: SUBMITTERS[0] }))).toBe("ignored");
      expect(ledger.snapshot().appliedEvents).toBe(0);
    });

    it("folds events decoded from contract XDR", () => {
      const sym = (v: string) => nativeToScVal(v, { type: "symbol" });
      const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
      const u64 = (v: bigint) => nativeToScVal(v, { type: "u64" });
      const raw = new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: new xdr.ContractId(StrKey.decodeContract(CONTRACT)),
        type: xdr.ContractEventType.contract,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({
            topics: [sym("oracle"), sym("staked")],
            data: xdr.ScVal.scvVec([new Address(SUBMITTERS[0]).toScVal(), i128(10n ** 25n), i128(10n ** 25n), u64(1n)]),
          }),
        ),
      });
      const decoded = decodeOracleContractEvent(raw, CONTRACT);
      if (decoded.status !== "decoded") throw new Error("expected decode");
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      expect(ledger.apply("tx:0:0", decoded)).toBe("applied");
      expect(ledger.snapshot().bonded).toBe(10n ** 25n);
    });
  });

  describe("failure path", () => {
    it.each([
      ["a gap in history (reported stake disagrees)", event("staked", { submitter: SUBMITTERS[0], amount: "5", total_stake: "50" }), "REPORTED_BALANCE_MISMATCH"],
      ["an overdrawn unbond", event("unbond", { submitter: SUBMITTERS[0], amount: "1", unlock_time: "1" }), "INSUFFICIENT_BONDED"],
      ["an overdrawn withdrawal", event("withdrawn", { submitter: SUBMITTERS[0], amount: "1" }), "INSUFFICIENT_UNBONDING"],
      ["a non-integer amount", event("staked", { submitter: SUBMITTERS[0], amount: "1.5", total_stake: "1.5" }), "INVALID_AMOUNT"],
    ])("refuses %s without changing state", (_label, bad, code) => {
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      const before = ledger.snapshot();
      expect(() => ledger.apply("x", bad)).toThrow(expect.objectContaining({ code }));
      expect(ledger.snapshot()).toEqual(before);
      // A refused id is not burned: the correct event can still use it.
      ledger.apply("x", event("staked", { submitter: SUBMITTERS[0], amount: "5", total_stake: "5" }));
      expect(ledger.checkInvariants()).toEqual([]);
    });
  });

  describe("retry path", () => {
    it("refuses an event id reused with different content", () => {
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      const [s] = SUBMITTERS;
      ledger.apply("1", event("staked", { submitter: s, amount: "5", total_stake: "5" }));
      expect(() => ledger.apply("1", event("staked", { submitter: s, amount: "6", total_stake: "11" }))).toThrow(
        expect.objectContaining({ code: "EVENT_ID_CONFLICT" }),
      );
      expect(ledger.snapshot().deposited).toBe(5n);
    });
  });

  describe("authorization path", () => {
    it("refuses stake events from any emitter but the configured contract", () => {
      const ledger = new OracleStakeTreasuryLedger(CONTRACT);
      expect(() =>
        ledger.apply("f", event("staked", { submitter: SUBMITTERS[0], amount: "5", total_stake: "5" }, FOREIGN)),
      ).toThrow(expect.objectContaining({ code: "UNAUTHORIZED_EMITTER" }));
      expect(ledger.snapshot().appliedEvents).toBe(0);
    });
  });
});
