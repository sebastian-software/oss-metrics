/**
 * Runs the collector against the real upstreams and prints the document's
 * shape and size — a check before deploying, not part of the test suite.
 *
 *   pnpm smoke            (set GITHUB_TOKEN to use the higher GitHub limit)
 */
import { gzipSync } from "node:zlib";

import { collectMetrics, metricsResponse } from "../src/collect.ts";

const metrics = await collectMetrics(fetch, {
  githubOrg: "sebastian-software",
  githubTopic: "oss-project",
  githubExcludeTopic: "oss-exclude",
  githubToken: process.env.GITHUB_TOKEN,
  cratesUserId: "385008",
  npmMaintainer: "swernerx",
  userAgent: "oss-metrics smoke (https://github.com/sebastian-software/oss-metrics)",
});
const text = JSON.stringify(metrics);
const response = metricsResponse(metrics);
console.log("sources", metrics.sources);
console.log("repos", Object.keys(metrics.github).length, "crates", Object.keys(metrics.crates).length, "npm", Object.keys(metrics.npm).length);
console.log("bytes", text.length, "gzip", gzipSync(text).length);
console.log("status", response.status, "cache-control", response.headers.get("cache-control"));
