import assert from "node:assert/strict";
import { test } from "node:test";
import { checkApi } from "./synthetic-http-check.mjs";

test("retries transient health errors and verifies export authentication", async () => {
  let healthAttempts = 0;
  const results = await checkApi("https://example.test/api", {
    backoff: async () => {},
    fetcher: async url => {
      if (url.pathname === "/api/exports") return new Response(null, { status: 401 });
      healthAttempts += 1;
      return healthAttempts === 1
        ? new Response(null, { status: 503 })
        : new Response(null, { headers: { "x-trellis-health": "ok" } });
    },
  });
  assert.deepEqual(results, [
    { name: "health", ok: true, status: 200, attempt: 2 },
    { name: "export-auth", ok: true, status: 401, attempt: 1 },
  ]);
});

test("reports persistent failures and an unexpectedly public exports endpoint", async () => {
  const results = await checkApi("https://example.test/api", {
    backoff: async () => {},
    fetcher: async url => {
      if (url.pathname.endsWith("/exports")) return new Response(null);
      throw new Error("offline");
    },
  });
  assert.deepEqual(results, [
    { name: "health", ok: false, status: null, attempt: 3 },
    { name: "export-auth", ok: false, status: 200, attempt: 1 },
  ]);
});
