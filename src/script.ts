/**
 * The Bunny edge script: serves the organization's metrics as one JSON
 * document. It runs on a cache miss only — the pull zone in front caches the
 * response for an hour (see README) — so the registries see a handful of
 * requests an hour, whatever the traffic.
 *
 * Configuration comes from the script's environment (Bunny: Env Configuration);
 * `GITHUB_TOKEN` belongs in its secrets.
 */
import * as BunnySDK from "@bunny.net/edgescript-sdk";

import { collectMetrics, type Config, metricsResponse } from "./collect.ts";

const config: Config = {
  githubOrg: process.env.GITHUB_ORG ?? "sebastian-software",
  githubTopic: process.env.GITHUB_TOPIC ?? "oss-project",
  githubToken: process.env.GITHUB_TOKEN,
  cratesUserId: process.env.CRATES_USER_ID ?? "385008",
  npmMaintainer: process.env.NPM_MAINTAINER ?? "swernerx",
  userAgent: "oss-metrics (https://github.com/sebastian-software/oss-metrics)",
};

const CORS_PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

BunnySDK.net.http.serve(async (request: Request) => {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_PREFLIGHT });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (pathname === "/v1/metrics.json") return metricsResponse(await collectMetrics(fetch, config));
  if (pathname === "/health") return new Response("ok", { headers: { "cache-control": "no-store" } });
  return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=3600" } });
});
