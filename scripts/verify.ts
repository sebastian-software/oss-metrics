/**
 * Smoke-checks a deployed endpoint: a healthy, CORS-open document with every
 * source answering, and a repeat request served from the edge cache. A source
 * reported as `skipped` (releases, without a GitHub token) is configuration,
 * not a failure: it passes with a notice, as provisioning does.
 *
 *   node scripts/verify.ts https://sebastian-oss-metrics.b-cdn.net [https://metrics.sebastian-software.com]
 */

const PATH = "/v1/metrics.json";
const ATTEMPTS = 8;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Check = { ok: boolean; reason: string; cache?: null | string; skipped?: string[] };

async function check(base: string): Promise<Check> {
  const response = await fetch(`${base}${PATH}`, { headers: { accept: "application/json" } });
  const cache = response.headers.get("cdn-cache");
  if (response.status !== 200) return { ok: false, reason: `status ${response.status}`, cache };
  if (response.headers.get("access-control-allow-origin") !== "*") {
    return { ok: false, reason: "CORS header missing", cache };
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not a JSON object", cache };
  const document = body as { schema?: unknown; sources?: Record<string, unknown> };
  if (document.schema !== 1) return { ok: false, reason: `schema ${String(document.schema)}`, cache };
  const sources = Object.entries(document.sources ?? {});
  const failing = sources.filter(([, state]) => state !== "ok" && state !== "skipped");
  if (failing.length > 0) return { ok: false, reason: `sources failing: ${failing.map(([name]) => name).join(", ")}`, cache };
  const skipped = sources.filter(([, state]) => state === "skipped").map(([name]) => name);
  return { ok: true, reason: skipped.length > 0 ? `healthy, skipped: ${skipped.join(", ")}` : "healthy", cache, skipped };
}

/** Healthy first, then cached: retried, since consecutive requests can reach different edge nodes. */
export async function verify(base: string): Promise<void> {
  let last: Check = { ok: false, reason: "not checked" };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await check(base);
    console.log(`${base}${PATH} #${attempt}: ${last.reason}, CDN-Cache ${last.cache ?? "—"}`);
    if (last.ok && last.cache?.toUpperCase() === "HIT") {
      if (last.skipped?.length) {
        console.log(`::notice::${base}: skipped sources (${last.skipped.join(", ")}); set METRICS_GITHUB_TOKEN to enable releases.`);
      }
      return;
    }
    await pause(attempt * 1000);
  }
  throw new Error(`${base}${PATH} ${last.ok ? "never came from the cache" : `is unhealthy: ${last.reason}`}`);
}

if (import.meta.main) {
  const bases = process.argv.slice(2).filter(Boolean);
  if (bases.length === 0) throw new Error("usage: node scripts/verify.ts <base-url> [<base-url> …]");
  for (const base of bases) await verify(base.replace(/\/$/u, ""));
}
