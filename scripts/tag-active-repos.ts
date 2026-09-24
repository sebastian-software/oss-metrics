/**
 * Adds the opt-in topic to every public, non-archived, non-fork repository of
 * the organization that released something in the last six months — a GitHub
 * release, or a crates.io / npm publish whose package metadata points at the
 * repository. Only adds; it never removes a topic.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/tag-active-repos.ts           # dry run
 *   GITHUB_TOKEN=$(gh auth token) node scripts/tag-active-repos.ts --apply   # write topics
 *
 * A repository carrying the blocker topic (`oss-exclude`) is never tagged: the
 * decision "releases, but is not a project" lives on the repository itself.
 *
 * Options: --months=6, --topic=oss-project, --blocker=oss-exclude
 */
import { repoOf as repoIn } from "../src/collect.ts";

const ORG = "sebastian-software";
const CRATES_USER_ID = "385008";
const NPM_MAINTAINER = "swernerx";
const UA = "oss-metrics topic tagger (https://github.com/sebastian-software/oss-metrics)";


const argument = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const apply = process.argv.includes("--apply");
const months = Number(argument("months", "6"));
const topic = argument("topic", "oss-project");
const blocker = argument("blocker", "oss-exclude");
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required (e.g. GITHUB_TOKEN=$(gh auth token))");

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - months);

type Repo = { name: string; archived: boolean; fork: boolean; topics: string[] };

async function github(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": UA,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
  return response.json() as Promise<unknown>;
}

/** The org repository a package links to, lower-cased for matching. */
const repoOf = (url: unknown) => repoIn(url, ORG)?.toLowerCase();

async function listRepos(): Promise<Repo[]> {
  const repos: Repo[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = (await github(`/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`)) as Repo[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((repo) => !repo.archived && !repo.fork && !repo.topics.includes(blocker));
}

async function latestGithubRelease(repo: string): Promise<string | undefined> {
  const releases = (await github(`/repos/${ORG}/${repo}/releases?per_page=1`)) as {
    published_at?: null | string;
  }[];
  return releases[0]?.published_at ?? undefined;
}

/** Latest publish per repository from crates.io and npm, keyed by lower-case repo name. */
async function registryPublishes(): Promise<Map<string, { at: string; what: string }>> {
  const latest = new Map<string, { at: string; what: string }>();
  const note = (repo: string | undefined, at: string | undefined, what: string) => {
    if (repo === undefined || at === undefined) return;
    const known = latest.get(repo);
    if (known === undefined || at > known.at) latest.set(repo, { at, what });
  };

  const crates = (await (
    await fetch(`https://crates.io/api/v1/crates?user_id=${CRATES_USER_ID}&per_page=100`, {
      headers: { "user-agent": UA },
    })
  ).json()) as { crates: { id: string; updated_at: string; repository?: null | string }[] };
  for (const crate of crates.crates) note(repoOf(crate.repository), crate.updated_at, `crate ${crate.id}`);

  const npm = (await (
    await fetch(`https://registry.npmjs.org/-/v1/search?text=maintainer:${NPM_MAINTAINER}&size=250`)
  ).json()) as { objects: { package: { name: string; date?: string; links?: { repository?: string } } }[] };
  for (const { package: pkg } of npm.objects) note(repoOf(pkg.links?.repository), pkg.date, `npm ${pkg.name}`);

  return latest;
}

const [repos, publishes] = await Promise.all([listRepos(), registryPublishes()]);
const rows: { repo: Repo; release?: string; publish?: { at: string; what: string } }[] = [];
for (const repo of repos) {
  rows.push({
    repo,
    release: await latestGithubRelease(repo.name),
    publish: publishes.get(repo.name.toLowerCase()),
  });
}

const isRecent = (at: string | undefined) => at !== undefined && new Date(at) >= cutoff;
const chosen = rows.filter((row) => isRecent(row.release) || isRecent(row.publish?.at));
const skipped = rows.filter((row) => !chosen.includes(row));

const day = (at: string | undefined) => at?.slice(0, 10) ?? "—";
console.log(`cutoff ${day(cutoff.toISOString())}, topic "${topic}", ${apply ? "APPLY" : "dry run"}\n`);
console.log(`released (${chosen.length}):`);
for (const row of chosen) {
  const has = row.repo.topics.includes(topic) ? " (already tagged)" : "";
  console.log(
    `  ${row.repo.name.padEnd(28)} release ${day(row.release).padEnd(10)}  publish ${day(row.publish?.at).padEnd(10)} ${row.publish?.what ?? ""}${has}`,
  );
}
console.log(`\nnot released in ${months} months (${skipped.length}):`);
for (const row of skipped) {
  console.log(`  ${row.repo.name.padEnd(28)} release ${day(row.release).padEnd(10)}  publish ${day(row.publish?.at)}`);
}

if (apply) {
  for (const row of chosen) {
    if (row.repo.topics.includes(topic)) continue;
    // The topics endpoint replaces the whole list, so send the existing topics along.
    await github(`/repos/${ORG}/${row.repo.name}/topics`, {
      method: "PUT",
      body: JSON.stringify({ names: [...row.repo.topics, topic] }),
    });
    console.log(`tagged ${row.repo.name}`);
  }
}

