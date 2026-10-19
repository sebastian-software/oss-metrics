/** Private Rybbit queries; only project totals cross the public boundary. */
export type RybbitSourceConfig = { settings?: string; apiKey?: string };

export type UsageWindow = {
  start: string;
  /** Exclusive UTC boundary. */
  end: string;
  count: number | null;
  observedCount: number | null;
  coverage: "complete" | "partial" | "unverified" | "unavailable";
  observedFrom: string | null;
};

export type ProjectUsage = {
  unit: "update_checks";
  collectedAt: string;
  /** Released-client ingestion has been independently observed for this project. */
  verified: boolean;
  windows: { days7: UsageWindow; days30: UsageWindow };
};

type Settings = {
  endpoint: string;
  siteId: string;
  projects: string[];
  verifiedProjects: string[];
  availableFrom: number;
  retentionDays: number | null;
};
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const DAY = 86_400_000;
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;
// The verified v2.6.0 properties contract has a hard, unpaginated LIMIT 500.
const ROW_LIMIT = 500;
const PROPERTIES = ["project", "version", "os", "arch", "mode", "installedSince"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");

function projectList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 &&
    value.every((entry) => typeof entry === "string" && /^[a-z][a-z0-9-]{0,99}$/u.test(entry)) &&
    new Set(value).size === value.length;
}

function settingsOf(json: string): Settings {
  const value: unknown = JSON.parse(json);
  if (!record(value) || typeof value.endpoint !== "string" || typeof value.siteId !== "string" ||
    !/^[1-9]\d*$/u.test(value.siteId) || !projectList(value.projects) || value.projects.length === 0 ||
    typeof value.availableFrom !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.availableFrom) ||
    (value.retentionDays !== null && (!Number.isSafeInteger(value.retentionDays) ||
      Number(value.retentionDays) < 1 || Number(value.retentionDays) > 36500))) {
    throw new Error("Invalid Rybbit configuration");
  }
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search ||
    endpoint.hash || endpoint.pathname !== "/") throw new Error("Invalid Rybbit origin");
  const availableFrom = Date.parse(`${value.availableFrom}T00:00:00Z`);
  if (!Number.isFinite(availableFrom) || iso(availableFrom).slice(0, 10) !== value.availableFrom) {
    throw new Error("Invalid Rybbit coverage date");
  }
  const verifiedProjects = value.verifiedProjects ?? [];
  const projects = value.projects;
  if (!projectList(verifiedProjects) || verifiedProjects.some((project) => !projects.includes(project))) {
    throw new Error("Invalid Rybbit project verification");
  }
  return {
    endpoint: endpoint.origin, siteId: value.siteId, projects: value.projects, verifiedProjects,
    availableFrom, retentionDays: value.retentionDays === null ? null : Number(value.retentionDays),
  };
}

/** Deployment validation shares the exact runtime contract and redacts parser errors. */
export function validateRybbitConfig(config: Required<RybbitSourceConfig>): void {
  try {
    if (!config.apiKey || /[\r\n]/u.test(config.apiKey)) throw new Error();
    settingsOf(config.settings);
  } catch {
    throw new Error("Invalid Rybbit configuration");
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Rybbit query failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("Rybbit response exceeds the size limit");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reject truncation and protocol drift before treating a missing project as zero. */
function projectCounts(body: unknown): Map<string, number> {
  if (!record(body) || Object.keys(body).length !== 1 || !Array.isArray(body.data) || body.data.length >= ROW_LIMIT) {
    throw new Error("Incomplete Rybbit aggregate response");
  }
  const counts = new Map<string, number>();
  const totals = new Map(PROPERTIES.map((property) => [property, 0]));
  const seen = new Set<string>();
  for (const row of body.data as unknown[]) {
    if (!record(row) || Object.keys(row).length !== 3 || typeof row.propertyKey !== "string" ||
      !totals.has(row.propertyKey) || (typeof row.propertyValue !== "string" && typeof row.propertyValue !== "number") ||
      (typeof row.propertyValue === "number" && !Number.isFinite(row.propertyValue)) ||
      !Number.isSafeInteger(row.count) || Number(row.count) < 0) throw new Error("Invalid Rybbit aggregate row");
    const key = JSON.stringify([row.propertyKey, String(row.propertyValue)]);
    if (seen.has(key)) throw new Error("Duplicate Rybbit aggregate row");
    seen.add(key);
    const total = totals.get(row.propertyKey)! + Number(row.count);
    if (!Number.isSafeInteger(total)) throw new Error("Rybbit count exceeds the integer limit");
    totals.set(row.propertyKey, total);
    if (row.propertyKey === "project") {
      if (typeof row.propertyValue !== "string") throw new Error("Invalid Rybbit project property");
      counts.set(row.propertyValue, Number(row.count));
    }
  }
  if (new Set(totals.values()).size !== 1) throw new Error("Incomplete Rybbit event properties");
  return counts;
}

export async function collectRybbit(
  fetchImpl: Fetch,
  config: RybbitSourceConfig | undefined,
  now: Date,
): Promise<Record<string, ProjectUsage> | null> {
  if (!config?.settings || !config.apiKey) return null;
  // Never retain upstream errors: their messages may include the private URL or credential.
  try {
    if (/[\r\n]/u.test(config.apiKey)) throw new Error("Invalid Rybbit credential");
    const settings = settingsOf(config.settings);
    const collectedAt = iso(now.getTime());
    const end = Math.floor(now.getTime() / DAY) * DAY;
    // Rolling retention can remove part of the oldest UTC day. Round inward.
    const retainedFrom = settings.retentionDays === null ? settings.availableFrom
      : Math.ceil((now.getTime() - settings.retentionDays * DAY) / DAY) * DAY;
    const availableFrom = Math.max(settings.availableFrom, retainedFrom);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const windows = await Promise.allSettled([7, 30].map(async (days) => {
        const start = end - days * DAY;
        const observedFrom = Math.max(start, availableFrom);
        const base = { start: iso(start), end: iso(end) };
        if (observedFrom >= end) return {
          base, observedFrom: null, coverage: "unavailable" as const, counts: null,
        };
        const url = new URL(`/api/sites/${settings.siteId}/events/properties`, settings.endpoint);
        url.search = new URLSearchParams({
          event_name: "update_check", time_zone: "UTC",
          start_datetime: iso(observedFrom), end_datetime: iso(end),
        }).toString();
        const response = await fetchImpl(url.href, {
          headers: { accept: "application/json", authorization: `Bearer ${config.apiKey}` },
          redirect: "error", cache: "no-store", signal: controller.signal,
        });
        const counts = projectCounts(await readJson(response));
        return {
          base, observedFrom: iso(observedFrom),
          coverage: settings.retentionDays === null ? "unverified" as const
            : observedFrom === start ? "complete" as const : "partial" as const, counts,
        };
      }));
      if (windows.some((window) => window.status === "rejected")) throw new Error("Rybbit collection failed");
      const values = windows.map((window) => {
        if (window.status !== "fulfilled") throw new Error("Rybbit collection failed");
        return window.value;
      });
      return Object.fromEntries(settings.projects.map((project) => {
        const projectWindows = values.map((window): UsageWindow => {
          const observedCount = window.counts === null ? null : window.counts.get(project) ?? 0;
          return {
            ...window.base, observedFrom: window.observedFrom, coverage: window.coverage, observedCount,
            count: window.coverage === "complete" ? observedCount : null,
          };
        });
        return [project, {
          unit: "update_checks", collectedAt, verified: settings.verifiedProjects.includes(project),
          windows: { days7: projectWindows[0], days30: projectWindows[1] },
        } satisfies ProjectUsage];
      }));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  } catch {
    throw new Error("Rybbit collection failed");
  }
}
