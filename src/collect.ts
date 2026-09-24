/**
 * Collects the public metrics of every Sebastian Software project in three
 * upstream requests — one per source — and merges them into one small JSON
 * document. Ownership is implicit: each source is queried by owner (GitHub
 * organization, crates.io user, npm maintainer), so nothing someone else
 * published under a similar name can appear.
 *
 * Pure on purpose: it takes `fetch` as a parameter, so it runs unchanged in the
 * Bunny edge runtime and in `node --test`.
 */

export type Config = {
  /** GitHub organization whose public, non-archived, non-fork repositories are listed. */
  githubOrg: string;
  /** Optional token: raises GitHub's limit from 60 to 5,000 requests an hour. */
  githubToken?: string;
  /** Numeric crates.io user id whose crates are listed (swernerx: 385008). */
  cratesUserId: string;
  /** npm maintainer whose packages are listed. */
  npmMaintainer: string;
  /** Sent upstream: crates.io asks API clients to identify themselves. */
  userAgent: string;
};

export type RepoMetrics = { stars: number; forks: number; pushedAt: string };
export type CrateMetrics = { version: string; downloads: number; recentDownloads: number };
export type PackageMetrics = { version: string; monthlyDownloads: number };
export type SourceStatus = "error" | "ok";

export type Metrics = {
  schema: 1;
  generatedAt: string;
  sources: { github: SourceStatus; crates: SourceStatus; npm: SourceStatus };
  github: Record<string, RepoMetrics>;
  crates: Record<string, CrateMetrics>;
  npm: Record<string, PackageMetrics>;
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Upper bounds on pagination, so one request never exceeds the edge's subrequest budget. */
const MAX_PAGES = { github: 5, crates: 5 };

/**
 * Per-platform binaries of a native package (`@palamedes/cli-linux-x64-gnu`):
 * implementation details of the package that depends on them, not projects.
 */
const PLATFORM_BINARY = /-(?:android|darwin|freebsd|linux|wasm32|win32)(?:-|$)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function count(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

async function getJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ body: unknown; next?: string }> {
  const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  // GitHub paginates with a Link header; crates.io carries the next page in the body.
  const next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get("link") ?? "")?.[1];
  return { body: await response.json(), next };
}

export async function collectGithub(fetchImpl: Fetch, config: Config) {
  const headers: Record<string, string> = { "user-agent": config.userAgent };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  const repos: Record<string, RepoMetrics> = {};
  let url: string | undefined =
    `https://api.github.com/orgs/${encodeURIComponent(config.githubOrg)}/repos?type=public&per_page=100`;
  for (let page = 0; url !== undefined && page < MAX_PAGES.github; page += 1) {
    const { body, next }: { body: unknown; next?: string } = await getJson(fetchImpl, url, headers);
    for (const repo of Array.isArray(body) ? (body as unknown[]) : []) {
      if (!isRecord(repo) || repo.archived === true || repo.fork === true) continue;
      const name = text(repo, "name");
      const stars = count(repo, "stargazers_count");
      const forks = count(repo, "forks_count");
      const pushedAt = text(repo, "pushed_at");
      if (name && stars !== undefined && forks !== undefined && pushedAt) {
        repos[name] = { stars, forks, pushedAt };
      }
    }
    url = next;
  }
  return repos;
}

export async function collectCrates(fetchImpl: Fetch, config: Config) {
  const headers = { "user-agent": config.userAgent };
  const crates: Record<string, CrateMetrics> = {};
  for (let page = 1; page <= MAX_PAGES.crates; page += 1) {
    const url = `https://crates.io/api/v1/crates?user_id=${encodeURIComponent(config.cratesUserId)}&per_page=100&page=${page}`;
    const { body } = await getJson(fetchImpl, url, headers);
    const list = isRecord(body) && Array.isArray(body.crates) ? (body.crates as unknown[]) : [];
    for (const crate of list) {
      if (!isRecord(crate)) continue;
      const id = text(crate, "id");
      const version = text(crate, "max_stable_version") ?? text(crate, "max_version");
      const downloads = count(crate, "downloads");
      const recentDownloads = count(crate, "recent_downloads") ?? 0;
      if (id && version && downloads !== undefined) {
        crates[id] = { version, downloads, recentDownloads };
      }
    }
    if (list.length < 100) break;
  }
  return crates;
}

export async function collectNpm(fetchImpl: Fetch, config: Config) {
  // The search API answers every package of a maintainer, scoped ones included,
  // with its version and monthly downloads — one request instead of one per package.
  const url = `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(config.npmMaintainer)}&size=250`;
  const { body } = await getJson(fetchImpl, url, { "user-agent": config.userAgent });
  const packages: Record<string, PackageMetrics> = {};
  const objects = isRecord(body) && Array.isArray(body.objects) ? (body.objects as unknown[]) : [];
  for (const entry of objects) {
    if (!isRecord(entry) || !isRecord(entry.package)) continue;
    const name = text(entry.package, "name");
    const version = text(entry.package, "version");
    const monthlyDownloads = isRecord(entry.downloads) ? count(entry.downloads, "monthly") : 0;
    if (name && version && !PLATFORM_BINARY.test(name)) {
      packages[name] = { version, monthlyDownloads: monthlyDownloads ?? 0 };
    }
  }
  return packages;
}

/**
 * Collects all three sources in parallel. A source that fails is reported as
 * `"error"` with an empty map; the others still answer.
 */
export async function collectMetrics(
  fetchImpl: Fetch,
  config: Config,
  now: Date = new Date(),
): Promise<Metrics> {
  const [github, crates, npm] = await Promise.allSettled([
    collectGithub(fetchImpl, config),
    collectCrates(fetchImpl, config),
    collectNpm(fetchImpl, config),
  ]);
  return {
    schema: 1,
    generatedAt: `${now.toISOString().slice(0, 19)}Z`,
    sources: {
      github: github.status === "fulfilled" ? "ok" : "error",
      crates: crates.status === "fulfilled" ? "ok" : "error",
      npm: npm.status === "fulfilled" ? "ok" : "error",
    },
    github: github.status === "fulfilled" ? github.value : {},
    crates: crates.status === "fulfilled" ? crates.value : {},
    npm: npm.status === "fulfilled" ? npm.value : {},
  };
}

/**
 * The response for a metrics document: CORS-open, cached for an hour at the
 * edge and five minutes in the browser — shorter when a source failed, so a
 * registry hiccup does not stick for an hour — and never cached when nothing
 * answered.
 */
export function metricsResponse(metrics: Metrics): Response {
  const states = Object.values(metrics.sources);
  const allFailed = states.every((state) => state === "error");
  const partial = states.includes("error");
  let cacheControl = "public, max-age=300, s-maxage=3600";
  if (partial) cacheControl = "public, max-age=60, s-maxage=300";
  if (allFailed) cacheControl = "no-store";
  return new Response(JSON.stringify(metrics), {
    status: allFailed ? 502 : 200,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": cacheControl,
      "content-type": "application/json; charset=utf-8",
    },
  });
}
