/** Public, screened monthly observations. No private reporting credentials. */
export const APP_TRACKING_FEED = "https://sebastian-app-tracking.b-cdn.net/v1/public/usage";
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Series = {
  month: string;
  tool_id: string;
  stream: string;
  metric: string;
  mode: string;
  state: "available" | "unavailable";
  count: string | null;
};
export type AppUsage = {
  schema_version: 1;
  unit: "reported_observations";
  window: "complete_utc_months";
  count_rounding: 10;
  snapshot_at: string;
  series: Series[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = () => new Error("App-tracking public feed unavailable");

/** Reconstruct the allowlisted projection; never forward upstream extras. */
export function checkedAppUsage(value: unknown, now = new Date()): AppUsage {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    value.unit !== "reported_observations" ||
    value.window !== "complete_utc_months" ||
    value.count_rounding !== 10 ||
    typeof value.snapshot_at !== "string" ||
    !Array.isArray(value.series) ||
    value.series.length > 300
  )
    throw invalid();
  const snapshot = Date.parse(value.snapshot_at);
  if (
    !Number.isFinite(snapshot) ||
    snapshot > now.getTime() + 300_000 ||
    snapshot < now.getTime() - 900_000
  )
    throw invalid();
  const current = now.toISOString().slice(0, 7) + "-01";
  const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1))
    .toISOString()
    .slice(0, 10);
  const seen = new Set<string>();
  const series = value.series.map((row: unknown): Series => {
    if (
      !record(row) ||
      typeof row.month !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(row.month) ||
      row.month < earliest ||
      row.month >= current ||
      !["dalo", "palamedes", "ferriki"].includes(String(row.tool_id)) ||
      !["legacy", "events"].includes(String(row.stream)) ||
      !["local", "ci"].includes(String(row.mode)) ||
      !["cli.invocation", "resource.download", "language.use"].includes(String(row.metric)) ||
      (row.stream === "legacy" && (row.tool_id === "ferriki" || row.metric !== "cli.invocation")) ||
      (row.stream === "events" &&
        (row.tool_id === "ferriki") === (row.metric === "cli.invocation")) ||
      !["available", "unavailable"].includes(String(row.state)) ||
      (row.state === "available"
        ? typeof row.count !== "string" ||
          !/^[1-9][0-9]{0,39}$/.test(row.count) ||
          BigInt(row.count) < 20n ||
          BigInt(row.count) % 10n !== 0n
        : row.count !== null)
    )
      throw invalid();
    const key = [row.month, row.tool_id, row.stream, row.metric, row.mode].join(":");
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return {
      month: row.month,
      tool_id: row.tool_id as string,
      stream: row.stream as string,
      metric: row.metric as string,
      mode: row.mode as string,
      state: row.state as Series["state"],
      count: row.count as string | null,
    };
  });
  return {
    schema_version: 1,
    unit: "reported_observations",
    window: "complete_utc_months",
    count_rounding: 10,
    snapshot_at: value.snapshot_at,
    series,
  };
}

/** No cache, append-only history, stale fallback, cookies, or arbitrary upstream. */
export async function appUsageResponse(fetchImpl: Fetch, now = new Date()): Promise<Response> {
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "cdn-cache-control": "no-store",
    "surrogate-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  const result = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers });
  const signal = AbortSignal.timeout(4000);
  try {
    const response = await fetchImpl(APP_TRACKING_FEED, {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (
      ![200, 404].includes(response.status) ||
      response.headers.get("cache-control") !== "no-store" ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      void response.body?.cancel().catch(() => {});
      throw invalid();
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    let size = 0;
    const chunks: Uint8Array[] = [];
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 262144) throw invalid();
        chunks.push(next.value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (response.status === 404) {
      if (!record(value) || value.error !== "not_found" || Object.keys(value).length !== 1)
        throw invalid();
      return result({ error: "not_enabled" }, 404);
    }
    return result(checkedAppUsage(value, now), 200);
  } catch {
    return result({ error: "source_unavailable" }, 503);
  }
}

export function handleAppUsage(
  request: Request,
  fetchImpl: Fetch,
  now = new Date(),
): Promise<Response> | Response {
  const headers = {
    "cache-control": "no-store",
    "cdn-cache-control": "no-store",
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  };
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { ...headers, "access-control-allow-methods": "GET, OPTIONS" },
    });
  if (request.method !== "GET")
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { ...headers, allow: "GET, OPTIONS" } },
    );
  if (new URL(request.url).search)
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  return appUsageResponse(fetchImpl, now);
}
