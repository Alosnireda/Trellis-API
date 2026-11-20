import {
  Signature,
  TypedDataField,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { canonicalJson } from "../../../common/serialization/canonical-json";
import type { OracleDomain } from "../services/payload-signing.service";
import {
  AUTHORIZATION_FINGERPRINT_SCHEMA,
  AuthorizationEnvelope,
  authorizationFingerprint,
  authorizationFingerprintDocument,
} from "./authorization-fingerprint";
import {
  AuthorizationReplayGuard,
  InMemoryReplayRecordStore,
  ReplayLeaseError,
  ReplayRecordStore,
} from "./authorization-replay-guard";
import {
  OracleSigningPort,
  oracleAuthorizationEnvelope,
  oracleSignatureVerifier,
} from "./payload-signing.authorization";

/*
 * Replay-safe authorization payload fingerprints (#336): normal, failure,
 * retry and authorization paths, against real EIP-712 signatures.
 */

const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const CONTRACT = "0x" + "ab".repeat(20);

/**
 * Mirrors PayloadSigningService's EIP-712 domain and `OraclePayload` types,
 * so signatures here are byte-identical to the service's.
 */
class TestOracleSigner implements OracleSigningPort {
  readonly types: Record<string, TypedDataField[]> = {
    OraclePayload: [
      { name: "payloadType", type: "string" },
      { name: "payloadHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
      { name: "data", type: "string" },
    ],
  };
  private readonly domain: OracleDomain;

  constructor(chainId = 1, verifyingContract = CONTRACT) {
    this.domain = { name: "Trellis Oracle", version: "1", chainId, verifyingContract };
  }

  getDomain(): OracleDomain {
    return this.domain;
  }

  hashPayload(payload: Record<string, unknown>): string {
    return keccak256(toUtf8Bytes(canonicalJson(payload)));
  }

  value(payloadType: string, payloadHash: string, nonce: string, expiresAt: number, data: Record<string, unknown>) {
    return {
      payloadType: payloadType.trim().toLowerCase(),
      payloadHash,
      nonce,
      expiresAt: String(expiresAt),
      data: canonicalJson(data),
    };
  }

  async sign(wallet: Wallet, payloadType: string, payloadHash: string, nonce: string, expiresAt: number, data: Record<string, unknown>) {
    return wallet.signTypedData(this.domain, this.types, this.value(payloadType, payloadHash, nonce, expiresAt, data));
  }

  verifySignature(
    signature: string,
    payloadType: string,
    payloadHash: string,
    nonce: string,
    expiresAt: number,
    data: Record<string, unknown>,
    expectedSigner: string,
  ): boolean {
    try {
      const recovered = verifyTypedData(
        this.domain,
        this.types,
        this.value(payloadType, payloadHash, nonce, expiresAt, data),
        signature,
      );
      return recovered.toLowerCase() === expectedSigner.toLowerCase();
    } catch {
      return false;
    }
  }
}

describe("authorization fingerprint (#336)", () => {
  const base: AuthorizationEnvelope = {
    domain: { name: "Trellis Oracle", version: "1", chainId: 1, verifyingContract: CONTRACT },
    signer: "0x" + "cd".repeat(20),
    payloadType: "price_feed",
    payloadHash: "0x" + "11".repeat(32),
    nonce: "7",
    expiresAt: NOW_S + 60,
  };

  it("is deterministic and stable across equivalent encodings", () => {
    const a = authorizationFingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      authorizationFingerprint({
        ...base,
        domain: { ...base.domain, chainId: 1n, verifyingContract: CONTRACT.toUpperCase().replace("0X", "0x") },
        signer: base.signer.toUpperCase().replace("0X", "0x"),
        payloadType: "  PRICE_FEED ",
        payloadHash: base.payloadHash.toUpperCase().replace("0X", "0x"),
        nonce: 7n,
        expiresAt: String(NOW_S + 60),
      }),
    ).toBe(a);
  });

  it("pins the committed document so a format change is a visible, versioned change", () => {
    expect(authorizationFingerprintDocument(base)).toBe(
      "{" +
        `"domain":{"chainId":"1","name":"Trellis Oracle","verifyingContract":"${CONTRACT}","version":"1"},` +
        `"expiresAt":${NOW_S + 60},"nonce":"7","payloadHash":"0x${"11".repeat(32)}",` +
        `"payloadType":"price_feed","schema":"${AUTHORIZATION_FINGERPRINT_SCHEMA}",` +
        `"signer":"0x${"cd".repeat(20)}"` +
        "}",
    );
  });

  it.each([
    ["chain", { domain: { ...base.domain, chainId: 2 } }],
    ["contract", { domain: { ...base.domain, verifyingContract: "0x" + "ef".repeat(20) } }],
    ["domain version", { domain: { ...base.domain, version: "2" } }],
    ["signer", { signer: "0x" + "ce".repeat(20) }],
    ["payload type", { payloadType: "oracle_update" }],
    ["payload hash", { payloadHash: "0x" + "12".repeat(32) }],
    ["nonce", { nonce: "8" }],
    ["expiry", { expiresAt: NOW_S + 61 }],
  ] as Array<[string, Partial<AuthorizationEnvelope>]>)("changes when the %s changes (no cross-context replay)", (_label, change) => {
    expect(authorizationFingerprint({ ...base, ...change })).not.toBe(authorizationFingerprint(base));
  });

  it.each([
    ["non-canonical nonce", { nonce: "07" }],
    ["negative nonce", { nonce: -1 }],
    ["fractional expiry", { expiresAt: 1.5 }],
    ["short hash", { payloadHash: "0x1234" }],
    ["malformed signer", { signer: "not-an-address" }],
    ["blank payload type", { payloadType: " " }],
  ] as Array<[string, Partial<AuthorizationEnvelope>]>)("rejects input with a %s", (_label, change) => {
    expect(() => authorizationFingerprint({ ...base, ...change })).toThrow();
  });
});

describe("AuthorizationReplayGuard (#336)", () => {
  const data = { feedId: "XLM/USD", price: "1250000", decimals: 7 };
  let signing: TestOracleSigner;
  let wallet: Wallet;
  let store: InMemoryReplayRecordStore;
  let clock: number;
  let guard: AuthorizationReplayGuard;

  async function signed(overrides: { nonce?: string; expiresAt?: number; data?: Record<string, unknown> } = {}) {
    const payload = overrides.data ?? data;
    const payloadHash = signing.hashPayload(payload);
    const nonce = overrides.nonce ?? "1";
    const expiresAt = overrides.expiresAt ?? NOW_S + 300;
    const signature = await signing.sign(wallet, "price_feed", payloadHash, nonce, expiresAt, payload);
    const signerAddress = getAddress(wallet.address);
    const envelope = oracleAuthorizationEnvelope(signing, {
      signer: signerAddress,
      payloadType: "price_feed",
      payloadHash,
      nonce,
      expiresAt,
    });
    return { envelope, signature, payload };
  }

  function guardFor(payload: Record<string, unknown>, s: ReplayRecordStore = store) {
    return new AuthorizationReplayGuard(s, oracleSignatureVerifier(signing, payload), {
      now: () => clock,
      leaseMs: 10_000,
      maxLifetimeSeconds: 3600,
      retentionGraceSeconds: 60,
      maxAttempts: 3,
    });
  }

  beforeEach(() => {
    signing = new TestOracleSigner();
    wallet = new Wallet(Wallet.createRandom().privateKey);
    store = new InMemoryReplayRecordStore();
    clock = NOW_MS;
    guard = guardFor(data);
  });

  describe("normal path", () => {
    it("accepts a fresh authorization once and refuses its replay", async () => {
      const { envelope, signature } = await signed();
      const first = await guard.claim(envelope, signature);
      expect(first).toMatchObject({ status: "accepted", attempt: 1 });
      if (first.status !== "accepted") throw new Error("unreachable");
      await guard.complete(first.fingerprint, first.leaseToken);

      expect(await guard.claim(envelope, signature)).toMatchObject({
        status: "rejected",
        code: "REPLAYED",
        retryable: false,
      });
    });

    it("treats distinct nonces as distinct authorizations", async () => {
      const a = await signed({ nonce: "1" });
      const b = await signed({ nonce: "2" });
      expect((await guard.claim(a.envelope, a.signature)).status).toBe("accepted");
      expect((await guard.claim(b.envelope, b.signature)).status).toBe("accepted");
    });
  });

  describe("authorization path", () => {
    it("refuses a re-encoded (EIP-2098 compact) signature of a used authorization", async () => {
      const { envelope, signature } = await signed();
      const compact = Signature.from(signature).compactSerialized;
      expect(compact).not.toBe(signature);

      const first = await guard.claim(envelope, signature);
      if (first.status !== "accepted") throw new Error("expected acceptance");
      await guard.complete(first.fingerprint, first.leaseToken);

      expect(await guard.claim(envelope, compact)).toMatchObject({ status: "rejected", code: "REPLAYED" });
    });

    it("never records anything for an invalid signature, so forgeries cannot burn a real one", async () => {
      const { envelope, signature } = await signed();
      const forged = await signing.sign(
        new Wallet(Wallet.createRandom().privateKey),
        "price_feed",
        envelope.payloadHash,
        "1",
        Number(envelope.expiresAt),
        data,
      );
      expect(await guard.claim(envelope, forged)).toMatchObject({ code: "SIGNATURE_INVALID", retryable: false });
      expect(await guard.claim(envelope, "0xdeadbeef")).toMatchObject({ code: "SIGNATURE_INVALID" });
      expect(store.size).toBe(0);
      expect((await guard.claim(envelope, signature)).status).toBe("accepted");
    });

    it("refuses data that does not match the signed payload hash", async () => {
      const { envelope, signature } = await signed();
      const tampered = guardFor({ ...data, price: "9999999" });
      expect(await tampered.claim(envelope, signature)).toMatchObject({ code: "SIGNATURE_INVALID" });
      expect(store.size).toBe(0);
    });

    it("refuses a signature replayed onto another chain or contract", async () => {
      const { envelope, signature, payload } = await signed();
      for (const other of [new TestOracleSigner(2), new TestOracleSigner(1, "0x" + "ef".repeat(20))]) {
        const replayed = oracleAuthorizationEnvelope(other, {
          signer: envelope.signer,
          payloadType: envelope.payloadType,
          payloadHash: envelope.payloadHash,
          nonce: String(envelope.nonce),
          expiresAt: Number(envelope.expiresAt),
        });
        expect(authorizationFingerprint(replayed)).not.toBe(authorizationFingerprint(envelope));
        const otherGuard = new AuthorizationReplayGuard(store, oracleSignatureVerifier(other, payload), {
          now: () => clock,
        });
        expect(await otherGuard.claim(replayed, signature)).toMatchObject({ code: "SIGNATURE_INVALID" });
      }
    });
  });

  describe("failure path", () => {
    it("refuses expired and over-long authorizations before touching the store", async () => {
      const expired = await signed({ expiresAt: NOW_S });
      expect(await guard.claim(expired.envelope, expired.signature)).toMatchObject({
        code: "EXPIRED",
        retryable: false,
      });
      const tooFar = await signed({ expiresAt: NOW_S + 7200 });
      expect(await guard.claim(tooFar.envelope, tooFar.signature)).toMatchObject({ code: "EXPIRY_TOO_FAR" });
      expect(store.size).toBe(0);
    });

    it("reports malformed envelopes without throwing", async () => {
      const { envelope, signature } = await signed();
      expect(await guard.claim({ ...envelope, nonce: "01" }, signature)).toMatchObject({
        status: "rejected",
        code: "MALFORMED",
        fingerprint: null,
      });
    });

    it("treats a throwing verifier as an invalid signature", async () => {
      const { envelope, signature } = await signed();
      const throwing = new AuthorizationReplayGuard(store, () => {
        throw new Error("boom");
      }, { now: () => clock });
      expect(await throwing.claim(envelope, signature)).toMatchObject({ code: "SIGNATURE_INVALID" });
    });

    it("prevents a stale worker from completing after its lease was reclaimed", async () => {
      const { envelope, signature } = await signed();
      const stale = await guard.claim(envelope, signature);
      if (stale.status !== "accepted") throw new Error("expected acceptance");
      clock += 10_001;
      const fresh = await guard.claim(envelope, signature);
      if (fresh.status !== "accepted") throw new Error("expected reclaim");
      await expect(guard.complete(stale.fingerprint, stale.leaseToken)).rejects.toBeInstanceOf(ReplayLeaseError);
      await guard.complete(fresh.fingerprint, fresh.leaseToken);
    });
  });

  describe("retry path", () => {
    it("lets the same signed request be retried after a transient failure", async () => {
      const { envelope, signature } = await signed();
      const first = await guard.claim(envelope, signature);
      if (first.status !== "accepted") throw new Error("expected acceptance");
      await guard.release(first.fingerprint, first.leaseToken, "RPC timeout");

      const retry = await guard.claim(envelope, signature);
      expect(retry).toMatchObject({ status: "accepted", attempt: 2 });
      expect((await store.get(first.fingerprint))?.lastError).toBe("RPC timeout");
    });

    it("blocks concurrent claims while a lease is live and frees it once the lease lapses", async () => {
      const { envelope, signature } = await signed();
      const results = await Promise.all([1, 2, 3, 4].map(() => guard.claim(envelope, signature)));
      expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toEqual(
        expect.arrayContaining([expect.objectContaining({ retryable: true })]),
      );

      clock += 10_001; // the claimant crashed without completing or releasing
      expect(await guard.claim(envelope, signature)).toMatchObject({ status: "accepted", attempt: 2 });
    });

    it("makes complete idempotent for a lost acknowledgement", async () => {
      const { envelope, signature } = await signed();
      const claim = await guard.claim(envelope, signature);
      if (claim.status !== "accepted") throw new Error("expected acceptance");
      await guard.complete(claim.fingerprint, claim.leaseToken);
      await expect(guard.complete(claim.fingerprint, claim.leaseToken)).resolves.toBeUndefined();
    });

    it("caps attempts per fingerprint", async () => {
      const { envelope, signature } = await signed();
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claim = await guard.claim(envelope, signature);
        if (claim.status !== "accepted") throw new Error(`attempt ${attempt} refused`);
        await guard.release(claim.fingerprint, claim.leaseToken, "transient");
      }
      expect(await guard.claim(envelope, signature)).toMatchObject({ code: "REPLAYED", retryable: false });
    });

    it("reports contention when compare-and-set keeps losing", async () => {
      const { envelope, signature } = await signed();
      const losing: ReplayRecordStore = {
        get: async () => undefined,
        compareAndSet: async () => false,
        deleteExpiredBefore: async () => 0,
      };
      expect(await guardFor(data, losing).claim(envelope, signature)).toMatchObject({
        code: "CONTENTION",
        retryable: true,
      });
    });
  });

  describe("retention", () => {
    it("prunes only after expiry plus grace, and a pruned authorization stays refused", async () => {
      const { envelope, signature } = await signed({ expiresAt: NOW_S + 30 });
      const claim = await guard.claim(envelope, signature);
      if (claim.status !== "accepted") throw new Error("expected acceptance");
      await guard.complete(claim.fingerprint, claim.leaseToken);

      clock = (NOW_S + 30 + 59) * 1000;
      expect(await guard.prune()).toBe(0);
      clock = (NOW_S + 30 + 61) * 1000;
      expect(await guard.prune()).toBe(1);
      expect(await guard.claim(envelope, signature)).toMatchObject({ code: "EXPIRED" });
    });
  });
});
