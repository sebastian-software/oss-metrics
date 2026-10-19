import assert from "node:assert/strict";
import { test } from "node:test";
import { filterProjects, packageUrl, parseSnapshot, relativeDate, usageLabel, type Usage } from "../site/model.ts";

function fixture() {
  return {
    schema: 1, generatedAt: "2026-10-19T09:00:00Z",
    sources: { github: "ok", releases: "skipped", npm: "ok", crates: "ok", skills: "ok" },
    github: {
      ferroni: { stars: 7, forks: 2, pushedAt: "2026-10-17T09:00:00Z" },
      palamedes: { stars: 20, forks: 1, pushedAt: "2026-10-18T09:00:00Z" },
      tooling: { stars: 0, forks: 0, pushedAt: "2026-10-16T09:00:00Z" },
    },
    npm: {
      "@palamedes/cli": { version: "1.0.0", monthlyDownloads: 100, repo: "palamedes", publishedAt: "2026-10-18T00:00:00Z" },
      "unlinked-package": { version: "2.0.0", monthlyDownloads: 250, publishedAt: "2026-10-01T00:00:00Z" },
    },
    crates: { ferroni: { version: "3.0.0", downloads: 1000, recentDownloads: 200, repo: "ferroni", publishedAt: "2026-10-17T00:00:00Z" } },
    skills: { skills: { "effective-web": { references: 146 } }, instructionPacks: 3 },
  };
}

test("the current snapshot works without optional analytics and joins packages only through their declared repository", () => {
  const snapshot = parseSnapshot(fixture());
  assert.equal(snapshot.sources.rybbit, "skipped");
  assert.equal(snapshot.usage.size, 0);
  assert.equal(snapshot.projects.find((project) => project.name === "palamedes")?.packages[0].name, "@palamedes/cli");
  assert.equal(snapshot.projects.find((project) => project.name === "ferroni")?.packages[0].downloads, 1000);
  assert.equal(snapshot.packages.length, 3, "unlinked packages remain in the package directory and totals");
  assert.equal(snapshot.projects.flatMap((project) => project.packages).length, 2);
  assert.equal(snapshot.packages.find((pkg) => pkg.registry === "crates")?.recentDownloads, 200);
  assert.equal(snapshot.projects[0].release, undefined);
  assert.deepEqual(snapshot.skills, [{ name: "effective-web", references: 146 }]);
});

test("failed sources remain unavailable even if their payload contains numbers", () => {
  const input = fixture();
  input.sources.npm = "error";
  input.sources.github = "error";
  const snapshot = parseSnapshot(input);
  assert.equal(snapshot.sources.npm, "error");
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.packages.some((pkg) => pkg.registry === "npm"), false);
  assert.equal(snapshot.packages[0].registry, "crates");
});

test("project search includes package names, filters registries, and sorts without changing source order", () => {
  const { projects } = parseSnapshot(fixture());
  assert.deepEqual(filterProjects(projects, " @PALAMEDES/CLI ", "all", "stars").map((project) => project.name), ["palamedes"]);
  assert.deepEqual(filterProjects(projects, "", "crates", "stars").map((project) => project.name), ["ferroni"]);
  assert.deepEqual(filterProjects(projects, "", "github", "name").map((project) => project.name), ["tooling"]);
  assert.deepEqual(filterProjects(projects, "", "all", "activity").map((project) => project.name), ["palamedes", "ferroni", "tooling"]);
  assert.deepEqual(projects.map((project) => project.name), ["ferroni", "palamedes", "tooling"]);
  assert.equal(filterProjects(projects, "nothing-matches", "all", "name").length, 0);
});

test("repository joins honor GitHub's case-insensitive names", () => {
  const input = fixture();
  input.crates.ferroni.repo = "FERRONI";
  assert.equal(parseSnapshot(input).projects.find((project) => project.name === "ferroni")?.packages.length, 1);
});

test("malformed optional usage does not hide valid GitHub or registry data", () => {
  const snapshot = parseSnapshot({ ...fixture(), sources: { ...fixture().sources, rybbit: "ok" },
    usage: { palamedes: { unit: "users", verified: true } } });
  assert.equal(snapshot.sources.rybbit, "error");
  assert.equal(snapshot.usage.size, 0);
  assert.equal(snapshot.projects.length, 3);
  assert.equal(snapshot.packages.length, 3);
});

test("invalid schemas, counts, dates and path-shaped repository names are rejected instead of rendered", () => {
  for (const input of [
    { ...fixture(), schema: 2 }, { ...fixture(), generatedAt: "not a date" },
    { ...fixture(), github: { "../outside": fixture().github.ferroni } },
    { ...fixture(), github: { ferroni: { ...fixture().github.ferroni, stars: -1 } } },
    { ...fixture(), npm: { "../outside": fixture().npm["unlinked-package"] } },
    { ...fixture(), npm: null },
  ]) assert.throws(() => parseSnapshot(input));
});

test("usage never presents unverified, incomplete or stale observations as an active-user number", () => {
  const now = Date.parse("2026-10-19T10:00:00Z");
  const usage: Usage = { collectedAt: "2026-10-19T09:00:00Z", verified: true,
    window: { start: "2026-09-19T00:00:00Z", end: "2026-10-19T00:00:00Z", coverage: "complete", count: 172, observedCount: 172 } };
  assert.equal(usageLabel(usage, now).text, "172");
  assert.equal(usageLabel({ ...usage, verified: false }, now).text, "Unverified");
  assert.equal(usageLabel({ ...usage, window: { ...usage.window, coverage: "unverified", count: null } }, now).text, "Unverified");
  assert.equal(usageLabel({ ...usage, window: { ...usage.window, coverage: "partial", count: null } }, now).text, "Partial data");
  assert.equal(usageLabel(usage, now + 3 * 60 * 60 * 1000).text, "Stale");
  assert.equal(usageLabel({ ...usage, window: { ...usage.window, count: 0, observedCount: 0 } }, now).text, "0");
  assert.equal(usageLabel(undefined, now).text, "—");
});

test("registry links use fixed public hosts and encoded package path segments", () => {
  const { packages } = parseSnapshot(fixture());
  assert.equal(packageUrl(packages[0]), "https://www.npmjs.com/package/%40palamedes/cli");
  assert.equal(packageUrl(packages[2]), "https://crates.io/crates/ferroni");
  assert.equal(relativeDate("2026-10-19T09:00:00Z", Date.parse("2026-10-19T10:00:00Z")), "1h ago");
});
