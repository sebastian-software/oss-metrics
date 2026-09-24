import assert from "node:assert/strict";
import { test } from "node:test";

import { collectMetrics, type Config, metricsResponse, repoOf, versionOfTag } from "../src/collect.ts";

const config: Config = {
  githubOrg: "sebastian-software",
  githubTopic: "oss-project",
  githubExcludeTopic: "oss-exclude",
  cratesUserId: "385008",
  npmMaintainer: "swernerx",
  userAgent: "oss-metrics test",
};

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** A fake upstream: one answer per source, recording every request it saw. */
function upstream(
  overrides: Partial<Record<"github" | "github2" | "releases" | "crates" | "npm", () => Response>> = {},
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const answers = {
    github: () =>
      json(
        [
          { name: "ferroni", topics: ["managed-deps", "oss-project"], stargazers_count: 7, forks_count: 1 },
          { name: "homebrew-tap", topics: [], stargazers_count: 0, forks_count: 0 },
          { name: "standards", topics: ["oss-project", "oss-exclude"], stargazers_count: 2, forks_count: 0 },
          { name: "old-thing", archived: true, topics: ["oss-project"], stargazers_count: 99, forks_count: 0 },
          { name: "a-fork", fork: true, topics: ["oss-project"], stargazers_count: 3, forks_count: 0 },
        ],
        { link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next"' },
      ),
    github2: () => json([{ name: "ferromark", topics: ["oss-project"], stargazers_count: 8, forks_count: 0 }]),
    releases: () =>
      json({
        data: {
          organization: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { name: "ferroni", latestRelease: { tagName: "v1.5.1", publishedAt: "2026-09-24T09:00:00Z" } },
                { name: "ferromark", latestRelease: { tagName: "nightly", publishedAt: "2026-09-24T09:00:00Z" } },
                { name: "homebrew-tap", latestRelease: { tagName: "v9.9.9", publishedAt: "2026-09-24T09:00:00Z" } },
                { name: "a-fork", latestRelease: null },
              ],
            },
          },
        },
      }),
    crates: () =>
      json({
        crates: [
          {
            id: "ferroni",
            max_stable_version: "1.4.2",
            max_version: "1.4.2",
            downloads: 1746,
            recent_downloads: 1300,
            updated_at: "2026-09-23T08:00:00Z",
            repository: "https://github.com/sebastian-software/ferroni",
          },
        ],
      }),
    npm: () =>
      json({
        objects: [
          {
            package: {
              name: "@palamedes/cli",
              version: "1.25.0",
              date: "2026-09-09T12:00:00Z",
              links: { repository: "git+https://github.com/sebastian-software/palamedes.git" },
            },
            downloads: { monthly: 120, weekly: 30 },
          },
          {
            package: { name: "@palamedes/cli-linux-x64-gnu", version: "1.25.0", date: "2026-09-09T12:00:00Z" },
            downloads: { monthly: 90 },
          },
          {
            package: {
              name: "ferromark",
              version: "2.1.1",
              date: "2026-09-23T09:00:00Z",
              links: { repository: "https://github.com/someone-else/ferromark" },
            },
            downloads: { monthly: 304 },
          },
        ],
      }),
    ...overrides,
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === "https://api.github.com/graphql") return answers.releases();
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
  assert.deepEqual(metrics.sources, { github: "ok", releases: "skipped", crates: "ok", npm: "ok" });
  assert.deepEqual(
    Object.keys(metrics.github).sort(),
    ["ferromark", "ferroni"],
    "only opted-in repositories; blocked, archived and forks drop out even when tagged",
  );
  assert.deepEqual(metrics.github.ferroni, { stars: 7, forks: 1 });
  assert.deepEqual(metrics.crates.ferroni, {
    version: "1.4.2",
    downloads: 1746,
    recentDownloads: 1300,
    publishedAt: "2026-09-23T08:00:00Z",
    repo: "ferroni",
  });
  assert.deepEqual(metrics.npm["@palamedes/cli"], {
    version: "1.25.0",
    monthlyDownloads: 120,
    publishedAt: "2026-09-09T12:00:00Z",
    repo: "palamedes",
  });
  assert.equal(metrics.npm.ferromark?.repo, undefined, "a repository outside the org is not linked");
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

test("repository links resolve to the org's repositories only", () => {
  const org = "sebastian-software";
  assert.equal(repoOf("git+https://github.com/sebastian-software/palamedes.git", org), "palamedes");
  assert.equal(repoOf("https://github.com/sebastian-software/ferroni/tree/main/crates", org), "ferroni");
  assert.equal(repoOf("git@github.com:sebastian-software/mdtheme.git", org), "mdtheme");
  assert.equal(repoOf("https://github.com/sebastian-softwarex/ferroni", org), undefined);
  assert.equal(repoOf(undefined, org), undefined);
});

test("with a token, each listed repository carries its latest release, in one GraphQL request", async () => {
  const { calls, fetchImpl } = upstream();
  const metrics = await collectMetrics(fetchImpl, { ...config, githubToken: "secret" });
  assert.equal(metrics.sources.releases, "ok");
  assert.deepEqual(metrics.github.ferroni?.release, {
    tag: "v1.5.1",
    version: "1.5.1",
    publishedAt: "2026-09-24T09:00:00Z",
  });
  assert.equal(metrics.github.ferromark?.release, undefined, "a tag without semver is no version");
  assert.equal(metrics.github["homebrew-tap"], undefined, "releases never add a repository the topic left out");
  assert.equal(calls.filter((call) => call.url.endsWith("/graphql")).length, 1);
});

test("a failing release lookup is reported without costing the stars", async () => {
  const { fetchImpl } = upstream({ releases: () => new Response("bad credentials", { status: 401 }) });
  const metrics = await collectMetrics(fetchImpl, { ...config, githubToken: "wrong" });
  assert.equal(metrics.sources.releases, "error");
  assert.equal(metrics.sources.github, "ok");
  assert.deepEqual(metrics.github.ferroni, { stars: 7, forks: 1 });
  assert.equal(metricsResponse(metrics).headers.get("cache-control"), "public, max-age=60, s-maxage=300");
});

test("release tags of every shape give their plain version", () => {
  assert.equal(versionOfTag("v0.3.0"), "0.3.0");
  assert.equal(versionOfTag("ferrolex-v0.4.0"), "0.4.0");
  assert.equal(versionOfTag("ferrugo-v0.5.0"), "0.5.0");
  assert.equal(versionOfTag("v2.0.0-rc.2"), "2.0.0-rc.2");
  assert.equal(versionOfTag("1.0.0"), "1.0.0");
  assert.equal(versionOfTag("nightly"), undefined);
});
