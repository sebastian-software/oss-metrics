import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRybbit, type RybbitSourceConfig, validateRybbitConfig } from "../src/rybbit.ts";

const now = new Date("2026-10-19T12:34:56Z");
const settings = {
  endpoint: "https://analytics.example.invalid", siteId: "42", projects: ["palamedes", "ferroni"],
  availableFrom: "2026-09-01", retentionDays: 90, verifiedProjects: ["ferroni"],
};
const config = (overrides: Record<string, unknown> = {}): Required<RybbitSourceConfig> => ({
  settings: JSON.stringify({ ...settings, ...overrides }), apiKey: "synthetic-test-key",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Synthetic six-property aggregates; no production rows or identifiers. */
function aggregate(projects: Record<string, number>) {
  const sum = Object.values(projects).reduce((total, count) => total + count, 0);
  return { data: [
    ...Object.entries(projects).map(([propertyValue, count]) => ({ propertyKey: "project", propertyValue, count })),
    ...["version", "os", "arch", "mode", "installedSince"].map((propertyKey) => ({
      propertyKey, propertyValue: "synthetic", count: sum,
    })),
  ] };
}

test("two event-specific UTC queries produce only allowlisted project totals and source freshness", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const result = await collectRybbit(async (url, init) => {
    calls.push({ url: new URL(url), init });
    return json(aggregate({ palamedes: 12, ferroni: 7, unrelated: 99 }));
  }, config(), now);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get("start_datetime")), [
    "2026-10-12T00:00:00Z", "2026-09-19T00:00:00Z",
  ]);
  for (const { url, init } of calls) {
    assert.equal(url.pathname, "/api/sites/42/events/properties");
    assert.equal(url.searchParams.get("event_name"), "update_check");
    assert.equal(url.searchParams.get("end_datetime"), "2026-10-19T00:00:00Z");
    assert.equal(url.searchParams.get("time_zone"), "UTC");
    assert.equal(url.searchParams.has("filters"), false, "custom-property and session filters are not assumed");
    assert.deepEqual(init?.headers, { accept: "application/json", authorization: "Bearer synthetic-test-key" });
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
  }
  assert.deepEqual(Object.keys(result!), ["palamedes", "ferroni"]);
  assert.deepEqual(result?.palamedes, {
    unit: "update_checks", collectedAt: "2026-10-19T12:34:56Z", verified: false,
    windows: {
      days7: { start: "2026-10-12T00:00:00Z", end: "2026-10-19T00:00:00Z", count: 12,
        observedCount: 12, observedFrom: "2026-10-12T00:00:00Z", coverage: "complete" },
      days30: { start: "2026-09-19T00:00:00Z", end: "2026-10-19T00:00:00Z", count: 12,
        observedCount: 12, observedFrom: "2026-09-19T00:00:00Z", coverage: "complete" },
    },
  });
  assert.equal(result?.ferroni.verified, true);
  const publicJson = JSON.stringify(result);
  for (const privateValue of [settings.endpoint, settings.siteId, "synthetic-test-key", "synthetic", "unrelated", "session", "user_id"]) {
    assert.ok(!publicJson.includes(privateValue), `public output excludes ${privateValue}`);
  }
});

test("a successful complete empty aggregate is a genuine zero, including an absent allowlisted project", async () => {
  for (const body of [{ data: [] }, aggregate({ unrelated: 5 })]) {
    const result = await collectRybbit(async () => json(body), config(), now);
    assert.equal(result?.palamedes.windows.days30.count, 0);
    assert.equal(result?.palamedes.windows.days30.coverage, "complete");
  }
});

test("the clean-data cutoff excludes earlier verification traffic and makes shorter coverage explicit", async () => {
  const starts: string[] = [];
  const result = await collectRybbit(async (url) => {
    starts.push(new URL(url).searchParams.get("start_datetime")!);
    return json(aggregate({ palamedes: 4 }));
  }, config({ availableFrom: "2026-10-15" }), now);
  assert.deepEqual(starts, ["2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z"]);
  assert.equal(result?.palamedes.windows.days30.count, null);
  assert.equal(result?.palamedes.windows.days30.observedCount, 4);
  assert.equal(result?.palamedes.windows.days30.coverage, "partial");
});

test("rolling retention rounds inward to complete UTC days instead of claiming a full 30-day count", async () => {
  const result = await collectRybbit(async () => json({ data: [] }), config({ retentionDays: 30 }), now);
  assert.equal(result?.palamedes.windows.days7.coverage, "complete");
  assert.deepEqual(result?.palamedes.windows.days30, {
    start: "2026-09-19T00:00:00Z", end: "2026-10-19T00:00:00Z", count: null,
    observedCount: 0, observedFrom: "2026-09-20T00:00:00Z", coverage: "partial",
  });
});

test("coverage beginning today has no complete days and issues no requests", async () => {
  const result = await collectRybbit(async () => { throw new Error("must not fetch"); },
    config({ availableFrom: "2026-10-19" }), now);
  assert.equal(result?.palamedes.windows.days7.coverage, "unavailable");
  assert.equal(result?.palamedes.windows.days7.count, null);
  assert.equal(result?.palamedes.windows.days7.observedCount, null);
  assert.equal(result?.palamedes.windows.days7.observedFrom, null);
});

test("unknown retention exposes observed totals without claiming a complete window", async () => {
  const result = await collectRybbit(async () => json(aggregate({ palamedes: 12 })), config({ retentionDays: null }), now);
  assert.equal(result?.palamedes.windows.days30.coverage, "unverified");
  assert.equal(result?.palamedes.windows.days30.count, null);
  assert.equal(result?.palamedes.windows.days30.observedCount, 12);
  assert.equal(result?.palamedes.windows.days30.observedFrom, "2026-09-19T00:00:00Z");
});

test("missing optional credentials skip analytics without issuing requests", async () => {
  for (const source of [undefined, {}, { settings: config().settings }, { apiKey: "test" }]) {
    assert.equal(await collectRybbit(async () => { throw new Error("must not fetch"); }, source, now), null);
  }
});

test("invalid private configuration fails with a fixed redacted message", async () => {
  for (const overrides of [
    { endpoint: "http://analytics.example.invalid" }, { endpoint: "https://user:secret@analytics.example.invalid" },
    { endpoint: "https://analytics.example.invalid/path" }, { siteId: "../another-site" },
    { projects: ["__proto__"] }, { projects: ["palamedes", "palamedes"] }, { projects: [] },
    { availableFrom: "2026-02-30" }, { retentionDays: 0 }, { retentionDays: 1.5 },
    { verifiedProjects: ["unlisted"] },
  ]) {
    assert.throws(() => validateRybbitConfig(config(overrides)), { message: "Invalid Rybbit configuration" });
    await assert.rejects(collectRybbit(async () => { throw new Error("must not fetch"); }, config(overrides), now),
      { message: "Rybbit collection failed" });
  }
});

test("query limits, incomplete properties, malformed rows and pagination cannot become zero counts", async () => {
  const valid = aggregate({ palamedes: 1 });
  for (const body of [
    {}, [], { data: null }, { data: [], cursor: { hasMore: true } },
    { data: Array.from({ length: 500 }, (_, n) => ({ propertyKey: "project", propertyValue: `p${n}`, count: 1 })) },
    { data: [...valid.data, valid.data[0]] },
    { data: valid.data.slice(1) },
    { data: [{ propertyKey: "project", propertyValue: "palamedes", count: -1 }] },
    { data: [{ propertyKey: "project", propertyValue: "palamedes", count: 1.5 }] },
    { data: [{ propertyKey: "project", propertyValue: "palamedes", count: Number.MAX_SAFE_INTEGER + 1 }] },
    { data: [{ propertyKey: "project", propertyValue: "palamedes", count: "1" }] },
    { data: [{ propertyKey: "other_event", propertyValue: "palamedes", count: 1 }] },
  ]) {
    await assert.rejects(collectRybbit(async () => json(body), config(), now), { message: "Rybbit collection failed" });
  }
});

test("unauthorized, rate-limited, malformed and oversized upstream responses stay unavailable", async () => {
  for (const response of [
    () => json({ data: [] }, 401), () => json({ data: [] }, 403), () => json({ data: [] }, 429),
    () => new Response("private malformed response"), () => new Response("x".repeat(256 * 1024 + 1)),
  ]) {
    await assert.rejects(collectRybbit(async () => response(), config(), now), { message: "Rybbit collection failed" });
  }
});

test("a failed window discards the source rather than publishing a mixed snapshot", async () => {
  await assert.rejects(collectRybbit(async (url) =>
    new URL(url).searchParams.get("start_datetime")?.startsWith("2026-09")
      ? json({}, 500) : json(aggregate({ palamedes: 10 })), config(), now), { message: "Rybbit collection failed" });
});

test("the shared deadline aborts both requests and sanitizes private upstream errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = 0;
  const pending = collectRybbit(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted++;
      reject(new Error("private upstream URL and credentials"));
    }, { once: true });
  }), config(), now);
  const assertion = assert.rejects(pending, { message: "Rybbit collection failed" });
  t.mock.timers.tick(5_000);
  await assertion;
  assert.equal(aborted, 2);
});
