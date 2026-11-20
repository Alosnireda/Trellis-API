import {
  buildKeyRing,
  capabilityKeyId,
  decodeCapabilityToken,
  encodeCapabilityToken,
} from "./capability-token.codec";
import {
  CAPABILITY_ACTION_POLICIES,
  CapabilityAction,
  CapabilityClaims,
  CapabilityRejection,
  isCapabilityTokenEnforced,
  MAX_CAPABILITY_TOKEN_LENGTH,
} from "./capability-token.types";
import { isSensitiveAction } from "src/infrastructure/audit/sensitive-actions/sensitive-action.enum";

const SECRET = "current-secret-0123456789abcdef0123456789";
const PREVIOUS = "previous-secret-0123456789abcdef012345678";

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    v: 1,
    kid: "",
    jti: "6f1c1d4e-2f6a-4f0e-9b1e-0b0c7a1f2d3e",
    sub: "user-1",
    act: CapabilityAction.API_KEY_REVOKE,
    res: "key-1",
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    ...overrides,
  };
}

describe("capability token codec (#273)", () => {
  const ring = buildKeyRing([SECRET]);

  it("round-trips signed claims and stamps the signing key id", () => {
    const token = encodeCapabilityToken(claims(), ring.active);
    expect(token.startsWith("cap1.")).toBe(true);
    const decoded = decodeCapabilityToken(token, ring);
    expect(decoded).toEqual({
      ok: true,
      claims: { ...claims(), kid: capabilityKeyId(SECRET) },
    });
  });

  it("rejects a token whose claims were edited after signing", () => {
    const token = encodeCapabilityToken(claims(), ring.active);
    const [prefix, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims(), kid: ring.active.kid, sub: "attacker" }),
    ).toString("base64url");
    expect(
      decodeCapabilityToken(`${prefix}.${forged}.${signature}`, ring),
    ).toEqual({
      ok: false,
      reason: CapabilityRejection.BAD_SIGNATURE,
    });
  });

  it("rejects a signature produced with a different secret under the same kid", () => {
    const attackerKey = { kid: ring.active.kid, secret: "guessed-secret" };
    const token = encodeCapabilityToken(claims(), attackerKey);
    expect(decodeCapabilityToken(token, ring)).toEqual({
      ok: false,
      reason: CapabilityRejection.BAD_SIGNATURE,
    });
  });

  it("verifies tokens from the previous key during rotation, and refuses them after", () => {
    const old = buildKeyRing([PREVIOUS]);
    const token = encodeCapabilityToken(claims(), old.active);

    const rotating = buildKeyRing([SECRET, PREVIOUS]);
    expect(rotating.active.kid).toBe(capabilityKeyId(SECRET));
    expect(decodeCapabilityToken(token, rotating).ok).toBe(true);

    expect(decodeCapabilityToken(token, buildKeyRing([SECRET]))).toEqual({
      ok: false,
      reason: CapabilityRejection.UNKNOWN_KEY,
    });
  });

  it("ignores blank and duplicate secrets when building the ring", () => {
    const built = buildKeyRing(["", undefined, ` ${SECRET} `, SECRET, null]);
    expect(built.verify).toHaveLength(1);
    expect(buildKeyRing([]).active).toBeNull();
  });

  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["wrong prefix", "jwt.e30.c2ln"],
    ["two parts", "cap1.e30"],
    ["non-base64url body", "cap1.e3+0.c2ln"],
    ["non-JSON body", `cap1.${Buffer.from("nope").toString("base64url")}.c2ln`],
    ["oversized", `cap1.${"a".repeat(MAX_CAPABILITY_TOKEN_LENGTH)}.c2ln`],
  ])(
    "rejects a malformed token (%s) before verifying anything",
    (_label, token) => {
      expect(decodeCapabilityToken(token, ring)).toEqual({
        ok: false,
        reason: CapabilityRejection.MALFORMED,
      });
    },
  );

  it.each([
    ["unknown action", { act: "treasury.payout.initiated" }],
    ["exp before iat", { exp: 1_799_999_999 }],
    ["fractional time", { iat: 1.5 }],
    ["empty subject", { sub: "" }],
    ["wrong version", { v: 2 }],
  ])(
    "rejects structurally invalid claims (%s) even when correctly signed",
    (_label, patch) => {
      const token = encodeCapabilityToken(
        { ...claims(), ...(patch as any) },
        ring.active,
      );
      expect(decodeCapabilityToken(token, ring)).toEqual({
        ok: false,
        reason: CapabilityRejection.MALFORMED,
      });
    },
  );

  it("only exposes actions that exist in the sensitive-action catalogue", () => {
    for (const action of Object.values(CapabilityAction)) {
      expect(isSensitiveAction(action)).toBe(true);
      expect(CAPABILITY_ACTION_POLICIES[action]).toBeDefined();
    }
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["0", false],
    ["true", true],
    [" YES ", true],
    ["1", true],
  ])("reads CAPABILITY_TOKENS_ENFORCED=%p as %p", (raw, expected) => {
    expect(isCapabilityTokenEnforced({ CAPABILITY_TOKENS_ENFORCED: raw })).toBe(
      expected,
    );
  });
});
