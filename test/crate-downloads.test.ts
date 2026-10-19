import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadsWindow, sumCrateDownloads } from "../src/crate-downloads.ts";
import { collectCrates, collectMetrics, type Config, metricsResponse } from "../src/collect.ts";

const now = new Date("2026-10-19T13:20:00Z");
const config: Config = {
  githubOrg: "sebastian-software", githubTopic: "oss-project", githubExcludeTopic: "oss-exclude",
  cratesUserId: "385008", npmMaintainer: "swernerx", skillsRepo: "skills", userAgent: "oss-metrics test",
};
const json = (body: unknown) => new Response(JSON.stringify(body));
const metadata = (id: string) => ({ id, max_stable_version: "1.0.0", downloads: 500, recent_downloads: 400, updated_at: now.toISOString() });
const daily = { version_downloads: [{ version: 1, date: "2026-10-18", downloads: 7 }], meta: { extra_downloads: [] } };

test("a rolling 30-day window ends before the current partial UTC day", () => {
  const window = downloadsWindow(now);
  assert.deepEqual(window, { start: "2026-09-19T00:00:00.000Z", end: "2026-10-19T00:00:00.000Z", count: null });
  assert.equal(sumCrateDownloads({
    version_downloads: [
      { version: 1, date: "2026-09-18", downloads: 999 },
      { version: 1, date: "2026-09-19", downloads: 2 },
      { version: 2, date: "2026-10-18", downloads: 3 },
      { version: 3, date: "2026-10-18", downloads: 5 },
      { version: 3, date: "2026-10-19", downloads: 999 },
    ],
    meta: { extra_downloads: [{ date: "2026-10-18", downloads: 11 }] },
  }, window), 21, "older versions are included without counting today or older history");
});

test("empty valid series is zero, while absent or malformed series never becomes zero", () => {
  const window = downloadsWindow(now);
  assert.equal(sumCrateDownloads({ version_downloads: [], meta: { extra_downloads: [] } }, window), 0);
  for (const body of [{}, { version_downloads: [], meta: {} },
    { ...daily, version_downloads: [{ date: "2026-02-30", downloads: 1 }] },
    { ...daily, version_downloads: [{ date: "2026-10-18", downloads: -1 }] },
    { ...daily, version_downloads: [{ date: "2026-10-18", downloads: 0.5 }] },
    { ...daily, version_downloads: [{ date: "2026-10-18", downloads: Number.MAX_SAFE_INTEGER }, { date: "2026-10-18", downloads: 1 }] },
  ]) assert.throws(() => sumCrateDownloads(body, window));
});

test("crate requests are spaced and a rate limit preserves completed counts and all metadata", async () => {
  const calls: { url: string; at: number }[] = [];
  const crates = await collectCrates(async (url, init) => {
    calls.push({ url, at: Date.now() });
    assert.equal((init?.headers as Record<string, string>)["user-agent"], config.userAgent);
    assert.ok(init?.signal);
    if (url.includes("?user_id=")) return json({ crates: [metadata("one"), metadata("two"), metadata("three")] });
    return url.includes("/one/") ? json(daily) : new Response("limited", { status: 429 });
  }, config, now);
  assert.equal(crates.one.downloads30Days.count, 7);
  assert.equal(crates.two.downloads30Days.count, null);
  assert.equal(crates.three.downloads30Days.count, null);
  assert.equal(crates.three.downloads, 500);
  assert.equal(calls.length, 3, "no further request after a rate limit");
  for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i].at - calls[i - 1].at >= 1000);
});

test("download lookup failure keeps the source available but shortens the response cache", async () => {
  const metrics = await collectMetrics(async (url) => {
    if (url.includes("?user_id=")) return json({ crates: [metadata("one")] });
    if (url.endsWith("/downloads")) return new Response("unavailable", { status: 503 });
    if (url.includes("/git/trees/")) return json({ tree: [], truncated: false });
    if (url.includes("registry.npmjs.org")) return json({ objects: [] });
    return json([]);
  }, config, now);
  assert.equal(metrics.sources.crates, "ok");
  assert.equal(metrics.crates.one.downloads, 500);
  assert.equal(metrics.crates.one.downloads30Days.count, null);
  assert.equal(metricsResponse(metrics).headers.get("cache-control"), "public, max-age=60, s-maxage=300");
});

test("download enrichment stays inside the edge subrequest budget", async (t) => {
  let clock = now.getTime();
  t.mock.method(Date, "now", () => clock);
  let calls = 0;
  const crates = await collectCrates(async (url) => {
    calls += 1;
    clock += 1100;
    return json(url.includes("?user_id=") ? { crates: Array.from({ length: 34 }, (_, i) => metadata(`crate-${i}`)) } : daily);
  }, config, now);
  assert.equal(calls, 31, "one metadata call and at most 30 download lookups");
  assert.equal(Object.values(crates).filter((crate) => crate.downloads30Days.count === 7).length, 30);
  assert.equal(crates["crate-33"].downloads30Days.count, null, "bounded work never invents zero downloads");
});
