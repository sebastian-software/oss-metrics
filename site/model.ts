/** The dashboard reads public schema 1 snapshots, including optional sources. */
export const ENDPOINT = "https://metrics.sebastian-software.com/v1/metrics.json";
export const ORG = "sebastian-software";
export const SOURCE_NAMES = {
  github: "GitHub", releases: "GitHub releases", npm: "npm", crates: "crates.io",
  skills: "Agent skills", rybbit: "CLI activity",
} as const;
export type Source = keyof typeof SOURCE_NAMES;
export type Status = "ok" | "error" | "skipped";
export type Package = {
  name: string; registry: "npm" | "crates"; version: string; downloads: number;
  recentDownloads?: number; publishedAt: string; repo?: string;
};
export type Project = {
  name: string; stars: number; forks: number; pushedAt: string; packages: Package[];
  release?: { version: string; tag: string; publishedAt: string };
};
export type Usage = {
  collectedAt: string; verified: boolean;
  window: { count: number | null; observedCount: number | null; coverage: string; start: string; end: string };
};
export type Snapshot = {
  generatedAt: string; sources: Record<Source, Status>; projects: Project[]; packages: Package[];
  skills: { name: string; references: number }[]; instructionPacks: number | null;
  usage: Map<string, Usage>;
};
export type ProjectFilter = "all" | "npm" | "crates" | "github";
export type ProjectSort = "stars" | "activity" | "name";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const slug = (value: string) => /^(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/iu.test(value);
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid metric text");
  return value;
}
function date(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error("Invalid metric timestamp");
  return text;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid metric count");
  return value;
}
function rows(value: unknown): [string, Record<string, unknown>][] {
  if (!record(value)) throw new Error("Missing metric data");
  return Object.entries(value).map(([name, row]) => {
    if (!record(row)) throw new Error("Invalid metric row");
    return [name, row];
  });
}

export function parseSnapshot(value: unknown): Snapshot {
  if (!record(value) || value.schema !== 1 || !record(value.sources)) throw new Error("Unsupported metrics snapshot");
  const sourceValues = value.sources;
  const sources = Object.fromEntries((Object.keys(SOURCE_NAMES) as Source[]).map((source) => {
    const state = sourceValues[source];
    return [source, state === "ok" || state === "error" || state === "skipped" ? state :
      source === "releases" || source === "rybbit" ? "skipped" : "error"];
  })) as Record<Source, Status>;
  const packages: Package[] = [];
  for (const registry of ["npm", "crates"] as const) {
    if (sources[registry] !== "ok") continue;
    for (const [name, row] of rows(value[registry])) {
      if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(name) || name.split("/").some((part) => /^\.{1,2}$/u.test(part))) {
        throw new Error("Invalid package name");
      }
      packages.push({
        name, registry, version: string(row.version), publishedAt: date(row.publishedAt),
        downloads: count(registry === "npm" ? row.monthlyDownloads : row.downloads),
        ...(registry === "crates" ? { recentDownloads: count(row.recentDownloads) } : {}),
        ...(typeof row.repo === "string" && slug(row.repo) ? { repo: row.repo } : {}),
      });
    }
  }
  const byRepo = new Map<string, Package[]>();
  for (const pkg of packages) {
    if (pkg.repo) {
      const key = pkg.repo.toLocaleLowerCase("en-US");
      byRepo.set(key, [...byRepo.get(key) ?? [], pkg]);
    }
  }
  const projects = sources.github === "ok" ? rows(value.github).map(([name, row]): Project => {
    if (!slug(name)) throw new Error("Invalid project name");
    const release = sources.releases === "ok" && record(row.release) ? {
      version: string(row.release.version), tag: string(row.release.tag), publishedAt: date(row.release.publishedAt),
    } : undefined;
    return { name, stars: count(row.stars), forks: count(row.forks), pushedAt: date(row.pushedAt),
      packages: byRepo.get(name.toLocaleLowerCase("en-US")) ?? [], ...(release ? { release } : {}) };
  }) : [];
  const skillsValue = value.skills;
  const skills = sources.skills === "ok" && record(skillsValue)
    ? rows(skillsValue.skills).map(([name, row]) => ({ name, references: count(row.references) })) : [];
  const instructionPacks = sources.skills === "ok" && record(skillsValue) ? count(skillsValue.instructionPacks) : null;
  const usage = new Map<string, Usage>();
  if (sources.rybbit === "ok") {
    try {
      if (!record(value.usage)) throw new Error("Missing usage data");
      for (const [name, item] of Object.entries(value.usage)) {
        if (!record(item) || item.unit !== "update_checks" || typeof item.verified !== "boolean" ||
          !record(item.windows) || !record(item.windows.days30)) throw new Error("Invalid usage data");
        const window = item.windows.days30;
        if (typeof window.coverage !== "string" || !["complete", "partial", "unavailable", "unverified"].includes(window.coverage)) {
          throw new Error("Invalid usage coverage");
        }
        const start = date(window.start), end = date(window.end);
        const completeCount = window.count === null ? null : count(window.count);
        const observedCount = window.observedCount === null ? null : count(window.observedCount);
        if (Date.parse(end) - Date.parse(start) !== 30 * 86_400_000 ||
          (window.coverage === "complete" && (completeCount === null || completeCount !== observedCount || window.observedFrom !== start))) {
          throw new Error("Invalid usage window");
        }
        usage.set(name, { collectedAt: date(item.collectedAt), verified: item.verified,
          window: { count: completeCount, observedCount, coverage: window.coverage, start, end } });
      }
    } catch {
      usage.clear();
      sources.rybbit = "error";
    }
  }
  return { generatedAt: date(value.generatedAt), sources, packages, projects, skills, instructionPacks, usage };
}

export function filterProjects(projects: Project[], query: string, filter: ProjectFilter, sort: ProjectSort): Project[] {
  const search = query.trim().toLocaleLowerCase("en-US");
  return projects.filter((project) =>
    (!search || [project.name, ...project.packages.map((pkg) => pkg.name)].some((name) => name.toLocaleLowerCase("en-US").includes(search))) &&
    (filter === "all" || (filter === "github" ? project.packages.length === 0 : project.packages.some((pkg) => pkg.registry === filter))))
    .sort((a, b) => {
      if (sort === "stars" && a.stars !== b.stars) return b.stars - a.stars;
      if (sort === "activity") {
        const delta = Date.parse(b.pushedAt) - Date.parse(a.pushedAt);
        if (delta) return delta;
      }
      return a.name.localeCompare(b.name, "en", { numeric: true });
    });
}

export function usageLabel(usage: Usage | undefined, now = Date.now()): { text: string; note: string } {
  if (!usage) return { text: "—", note: "No usage data" };
  if (!usage.verified || usage.window.coverage === "unverified") return { text: "Unverified", note: "Verification pending" };
  if (usage.window.coverage !== "complete" || usage.window.count === null) return {
    text: usage.window.coverage === "partial" ? "Partial data" : "Unavailable", note: "No complete 30-day window",
  };
  if (now - Date.parse(usage.collectedAt) > 2 * 60 * 60 * 1000) return { text: "Stale", note: "Usage snapshot is over two hours old" };
  return { text: compact(usage.window.count), note: `${integer(usage.window.count)} update checks over 30 complete UTC days` };
}

export const integer = (value: number) => new Intl.NumberFormat("en-US").format(value);
export const compact = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
export function relativeDate(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
export const repoUrl = (name: string) => `https://github.com/${ORG}/${encodeURIComponent(name)}`;
export const packageUrl = (pkg: Package) => pkg.registry === "crates"
  ? `https://crates.io/crates/${encodeURIComponent(pkg.name)}`
  : `https://www.npmjs.com/package/${pkg.name.split("/").map(encodeURIComponent).join("/")}`;
