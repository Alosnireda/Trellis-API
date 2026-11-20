import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export async function checkApi(base, { fetcher = fetch, backoff = sleep } = {}) {
  const routes = [
    ["health", "/health", response => response.status === 200 && response.headers.get("x-trellis-health") === "ok"],
    ["export-auth", "/exports", response => response.status === 401],
  ];

  return Promise.all(routes.map(async ([name, path, accepts]) => {
    const url = new URL(base.replace(/\/$/, "") + path);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let status = null;
      try {
        const response = await fetcher(url, {
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        status = response.status;
        const ok = accepts(response);
        await response.body?.cancel();
        if (ok || status < 500 || attempt === 3) return { name, ok, status, attempt };
      } catch {
        if (attempt === 3) return { name, ok: false, status, attempt };
      }
      await backoff(250 * attempt);
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.env.TRELLIS_SYNTHETIC_BASE_URL;
  if (!base) {
    console.error("Set TRELLIS_SYNTHETIC_BASE_URL to the deployed API prefix.");
    process.exitCode = 1;
  } else {
    try {
      const results = await checkApi(base);
      console.log(JSON.stringify(results));
      if (results.some(result => !result.ok)) process.exitCode = 1;
    } catch {
      console.error("Synthetic check could not use the configured API URL.");
      process.exitCode = 1;
    }
  }
}
