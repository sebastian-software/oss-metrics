/** Public, bounded crates.io daily-download aggregation. */
export type Downloads30Days = { start: string; end: string; count: number | null };

const DAY_MS = 86_400_000;

export function downloadsWindow(now: Date): Downloads30Days {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(end - 30 * DAY_MS).toISOString(),
    end: new Date(end).toISOString(),
    count: null,
  };
}

/** Includes the newest five versions and the disjoint older-version totals. */
export function sumCrateDownloads(body: unknown, window: Downloads30Days): number {
  if (typeof body !== "object" || body === null || !("version_downloads" in body) ||
    !Array.isArray(body.version_downloads) || !("meta" in body) ||
    typeof body.meta !== "object" || body.meta === null || !("extra_downloads" in body.meta) ||
    !Array.isArray(body.meta.extra_downloads)) throw new Error("Missing crate download series");
  let total = 0;
  for (const row of [...body.version_downloads, ...body.meta.extra_downloads] as unknown[]) {
    if (typeof row !== "object" || row === null || !("date" in row) ||
      typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      !("downloads" in row) || typeof row.downloads !== "number" ||
      !Number.isSafeInteger(row.downloads) || row.downloads < 0) throw new Error("Invalid crate download observation");
    const day = `${row.date}T00:00:00.000Z`;
    if (day >= window.start && day < window.end) total += row.downloads;
    if (!Number.isSafeInteger(total)) throw new Error("Crate download count exceeds the integer limit");
  }
  return total;
}
