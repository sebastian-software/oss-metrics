import assert from "node:assert/strict";
import { test } from "node:test";

import { collectMetrics, type Config, metricsResponse } from "../src/collect.ts";

const config: Config = {
  githubOrg: "sebastian-software",
  cratesUserId: "385008",
  npmMaintainer: "swernerx",
  userAgent: "oss-metrics test",
};

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** A fake upstream: one answer per source, recording every request it saw. */
function upstream(overrides: Partial<Record<"github" | "github2" | "crates" | "npm", () => Response>> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const answers = {
    github: () =>
      json(
        [
          { name: "ferroni", stargazers_count: 7, forks_count: 1, pushed_at: "2026-09-20T10:00:00Z" },
          { name: "old-thing", archived: true, stargazers_count: 99, forks_count: 0, pushed_at: "2019-01-01T00:00:00Z" },
          { name: "a-fork", fork: true, stargazers_count: 3, forks_count: 0, pushed_at: "2026-01-01T00:00:00Z" },
        ],
        { link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next"' },
      ),
    github2: () => json([{ name: "ferromark", stargazers_count: 8, forks_count: 0, pushed_at: "2026-09-22T10:00:00Z" }]),
    crates: () =>
      json({ crates: [{ id: "ferroni", max_stable_version: "1.4.2", max_version: "1.4.2", downloads: 1746, recent_downloads: 1300 }] }),
    npm: () =>
      json({
        objects: [
          { package: { name: "@palamedes/cli", version: "1.25.0" }, downloads: { monthly: 120, weekly: 30 } },
          { package: { name: "@palamedes/cli-linux-x64-gnu", version: "1.25.0" }, downloads: { monthly: 90 } },
          { package: { name: "ferromark", version: "2.1.1" }, downloads: { monthly: 304 } },
        ],
      }),
    ...overrides,
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("page=2") && url.includes("github")) return answers.github2();
    if (url.startsWith("https://api.github.com/")) return answers.github();
    if (url.startsWith("https://crates.io/")) return answers.crates();
    if (url.startsWith("https://registry.npmjs.org/")) return answers.npm();
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test("one document for the whole organization, from one request per source (plus pages)", async () => {
  const { calls, fetchImpl } = upstream();
  const metrics = await collectMetrics(fetchImpl, config, new Date("2026-09-24T10:00:00.123Z"));

  assert.equal(metrics.generatedAt, "2026-09-24T10:00:00Z");
  assert.deepEqual(metrics.sources, { github: "ok", crates: "ok", npm: "ok" });
  assert.deepEqual(Object.keys(metrics.github).sort(), ["ferromark", "ferroni"], "archived and forks drop out");
  assert.deepEqual(metrics.github.ferroni, { stars: 7, forks: 1, pushedAt: "2026-09-20T10:00:00Z" });
  assert.deepEqual(metrics.crates.ferroni, { version: "1.4.2", downloads: 1746, recentDownloads: 1300 });
  assert.deepEqual(metrics.npm["@palamedes/cli"], { version: "1.25.0", monthlyDownloads: 120 });
  assert.equal(metrics.npm["@palamedes/cli-linux-x64-gnu"], undefined, "platform binaries are not projects");
  assert.equal(calls.length, 4, "github (2 pages), crates, npm");
  assert.ok(calls.every((call) => call.headers["user-agent"] === "oss-metrics test"), "every call identifies itself");
});

test("a token goes to GitHub only", async () => {
  const { calls, fetchImpl } = upstream();
  await collectMetrics(fetchImpl, { ...config, githubToken: "secret" });
  for (const call of calls) {
    const sentToken = call.headers.authorization === "Bearer secret";
    assert.equal(sentToken, call.url.startsWith("https://api.github.com/"), call.url);
  }
});

test("a failing source is reported, the others still answer, and the cache stays short", async () => {
  const { fetchImpl } = upstream({ crates: () => new Response("rate limited", { status: 429 }) });
  const metrics = await collectMetrics(fetchImpl, config);
  assert.equal(metrics.sources.crates, "error");
  assert.deepEqual(metrics.crates, {});
  assert.ok(Object.keys(metrics.npm).length > 0);

  const response = metricsResponse(metrics);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60, s-maxage=300");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("nothing answered: a 502 that no cache keeps", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  const response = metricsResponse(await collectMetrics(fetchImpl, config));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a healthy document is cached an hour at the edge, five minutes in the browser", async () => {
  const { fetchImpl } = upstream();
  const response = metricsResponse(await collectMetrics(fetchImpl, config));
  assert.equal(response.headers.get("cache-control"), "public, max-age=300, s-maxage=3600");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
});
