# oss-metrics

Live public metrics for every Sebastian Software project — GitHub stars,
crates.io and npm versions and downloads — as **one small JSON document**,
served from a Bunny edge script and cached at the edge for an hour.

Sites read one URL instead of calling GitHub, crates.io and npm from every
visitor's browser. The registries see a handful of requests an hour, whatever
the traffic, each identified by a User-Agent as crates.io asks.

## Endpoint

`GET https://metrics.sebastian-software.com/v1/metrics.json`

```json
{
  "schema": 1,
  "generatedAt": "2026-09-24T10:00:00Z",
  "sources": { "github": "ok", "crates": "ok", "npm": "ok" },
  "github": { "ferroni": { "stars": 7, "forks": 1, "pushedAt": "2026-09-20T10:00:00Z" } },
  "crates": { "ferroni": { "version": "1.4.2", "downloads": 1746, "recentDownloads": 1300 } },
  "npm": { "@palamedes/cli": { "version": "1.25.0", "monthlyDownloads": 120 } }
}
```

- **What is listed:** public, non-archived, non-fork repositories of the GitHub
  organization; every crate of the crates.io owner; every npm package of the
  maintainer except per-platform binaries (`…-linux-x64-gnu` and friends).
  Ownership is implicit — each source is queried _by owner_, so a look-alike
  package somebody else published never appears.
- **Three upstream requests** per refresh (GitHub pages add one each per 100
  repositories): GitHub `orgs/{org}/repos`, crates.io `crates?user_id=`, npm
  `-/v1/search?text=maintainer:`. The npm search carries versions and monthly
  downloads for scoped packages too.
- **A failing source** is reported in `sources` with an empty map; the others
  still answer, and the document is cached for five minutes instead of an hour.
  When nothing answers: `502`, not cached.
- **Caching:** `Cache-Control: public, max-age=300, s-maxage=3600`, plus the pull
  zone rules below. CORS is open (`Access-Control-Allow-Origin: *`).
- **Size:** about 12 KB, 2.4 KB gzipped (62 repositories, 18 crates, 92 npm
  packages, 2026-09-24).
- `schema` changes only with a breaking change to the document's shape.

## Develop

```sh
pnpm install
pnpm check   # typecheck, tests (node --test), bundle to dist/script.js
pnpm smoke   # run the collector against the real upstreams, print shape and size
```

`src/collect.ts` is pure — `fetch` is a parameter — so it runs unchanged at the
edge and under `node --test`. `src/script.ts` is the Bunny entry point;
`pnpm build` bundles both into the single file the deploy action uploads, with
the Bunny SDK kept external (the edge runtime provides it).

## Set up (once, by hand)

1. **Bunny:** create a standalone Edge Script (this creates its pull zone).
2. **Environment** (Script → Env Configuration): optional `GITHUB_ORG`,
   `CRATES_USER_ID`, `NPM_MAINTAINER` (defaults: `sebastian-software`, `385008`,
   `swernerx`); **secret** `GITHUB_TOKEN` — a fine-grained token with public
   read access only, which lifts GitHub's limit from 60 to 5,000 requests an hour.
3. **Pull zone:** Caching → Vary Cache → _URL Query String_ off (the endpoint takes
   none); Edge Rule _Override Cache Time_ = 3600 on `/v1/*`; enable _Origin Shield_
   and _Request Coalescing_.
4. **Hostname:** add `metrics.sebastian-software.com`, CNAME it to the pull zone's
   `*.b-cdn.net` host, then _Verify & Activate SSL_.
5. **GitHub secrets** (Script → Deployments → Settings): `SCRIPT_ID`,
   `DEPLOY_KEY`. Pushing to `main` then deploys.

## Cost

Bunny bills $1 a month minimum per account; at tens of thousands of page views
this service stays well inside it (bandwidth well under a gigabyte, Edge
Scripting $0.20 per million requests — mostly served from cache).

## License

Apache-2.0
