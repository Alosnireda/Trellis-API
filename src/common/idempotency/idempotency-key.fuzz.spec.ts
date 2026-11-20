import { BadRequestException } from "@nestjs/common";
import { IdempotencyService } from "./idempotency.service";

describe("idempotency input boundaries", () => {
  const service = new IdempotencyService({} as never);

  it("accepts only supported lengths without retaining invalid input across retries", () => {
    for (let length = 0; length <= 130; length += 1) {
      const key = "a".repeat(length);
      if (length >= 8 && length <= 128) {
        expect(service.assertValidKey(key)).toBe(key);
      } else {
        expect(() => service.assertValidKey(key)).toThrow(BadRequestException);
      }
    }
    expect(service.assertValidKey("  valid-key  ")).toBe("valid-key");
  });

  it("rejects malformed key characters and keeps equivalent retries scoped by actor", () => {
    for (const character of [" ", "\t", "\n", "/", "é", "🙂"]) {
      expect(() => service.assertValidKey(`valid${character}key`)).toThrow(BadRequestException);
    }
    expect(service.hashRequest({ amount: 1, memo: "tip" })).toBe(
      service.hashRequest({ memo: "tip", amount: 1 }),
    );
    expect(service.buildScope("POST", "/payments", "alice")).not.toBe(
      service.buildScope("POST", "/payments", "bob"),
    );
  });
});
