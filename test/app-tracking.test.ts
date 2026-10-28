import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_TRACKING_FEED,
  appUsageResponse,
  checkedAppUsage,
  handleAppUsage,
} from "../src/app-tracking.ts";
const now = new Date("2026-10-28T12:00:00Z");
const fixture = () => ({
  schema_version: 1,
  unit: "reported_observations",
  window: "complete_utc_months",
  count_rounding: 10,
  snapshot_at: now.toISOString(),
  series: [
    {
      month: "2026-09-01",
      tool_id: "palamedes",
      stream: "events",
      metric: "cli.invocation",
      mode: "local",
      state: "available",
      count: "240",
    },
    {
      month: "2026-08-01",
      tool_id: "ferriki",
      stream: "events",
      metric: "language.use",
      mode: "local",
      state: "unavailable",
      count: null,
    },
  ],
});
const reply = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

test("the adapter uses only the fixed public feed and reconstructs its allowed monthly fields", async () => {
  const value = fixture();
  const response = await appUsageResponse(async (url, options) => {
    assert.equal(url, APP_TRACKING_FEED);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.credentials, "omit");
    assert.deepEqual(options?.headers, { accept: "application/json" });
    return reply({
      ...value,
      private_token: "secret",
      series: value.series.map((row) => ({
        ...row,
        installation_id: "secret",
        project_id: "secret",
        breakdowns: ["secret"],
      })),
    });
  }, now);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), value);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a replacement snapshot removes withdrawn values; disabled and failed sources produce no fallback or zero", async () => {
  const first = await appUsageResponse(async () => reply(fixture()), now);
  assert.equal((await first.json()).series[0].count, "240");
  const changed = fixture();
  changed.series[0]!.state = "unavailable";
  changed.series[0]!.count = null;
  const second = await appUsageResponse(async () => reply(changed), now);
  assert.equal((await second.json()).series[0].count, null);
  for (const status of [404, 500, 307]) {
    const response = await appUsageResponse(
      async () =>
        status === 404
          ? Response.json(
              { error: "not_found" },
              { status, headers: { "cache-control": "no-store" } },
            )
          : new Response("private upstream error", { status }),
      now,
    );
    assert.equal(response.status, status === 404 ? 404 : 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes("private upstream"));
  }
  const failed = await appUsageResponse(async () => {
    throw new Error("private transport details");
  }, now);
  assert.deepEqual(await failed.json(), { error: "source_unavailable" });
});

test("stale, oversized, ambiguous, or unsupported publication is rejected", async () => {
  const original = fixture();
  const variants = [
    { ...original, snapshot_at: "2026-10-28T11:00:00Z" },
    { ...original, snapshot_at: "2026-10-28T13:00:00Z" },
    { ...original, schema_version: 2 },
    { ...original, series: [original.series[0], original.series[0]] },
    ...[
      { count: "241" },
      { count: "0" },
      { month: "2026-10-01" },
      { month: "2024-09-01" },
      { month: "2026-13-01" },
      { stream: "all" },
      { mode: "all" },
      { tool_id: "other" },
      { tool_id: "ferriki" },
      { metric: "resource.download" },
      { state: "unavailable", count: "240" },
    ].map((change) => ({ ...original, series: [{ ...original.series[0], ...change }] })),
  ];
  for (const value of variants) {
    assert.throws(() => checkedAppUsage(value, now));
    assert.equal((await appUsageResponse(async () => reply(value), now)).status, 503);
  }
  assert.equal(
    (
      await appUsageResponse(
        async () =>
          new Response(" ".repeat(262145), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }),
        now,
      )
    ).status,
    503,
  );
  assert.equal((await appUsageResponse(async () => Response.json(original), now)).status, 503);
});

test("the consumer route rejects filters and mutations before fetching", async () => {
  const fetchNever = async () => {
    throw new Error("must not fetch");
  };
  for (const [method, suffix, expected] of [
    ["GET", "?tool=dalo", 400],
    ["POST", "", 405],
    ["OPTIONS", "", 204],
  ] as const) {
    const response = await handleAppUsage(
      new Request("https://metrics.example/v1/app-usage.json" + suffix, { method }),
      fetchNever,
      now,
    );
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
