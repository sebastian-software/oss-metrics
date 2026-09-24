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
  "github": { "ferroni": { "stars": 7, "forks": 1 } },
  "crates": {
    "ferroni": {
      "version": "1.4.2",
      "downloads": 1746,
      "recentDownloads": 1300,
      "publishedAt": "2026-09-23T08:00:00Z",
      "repo": "ferroni"
    }
  },
  "npm": {
    "@palamedes/cli": {
      "version": "1.25.0",
      "monthlyDownloads": 120,
      "publishedAt": "2026-09-09T12:00:00Z",
      "repo": "palamedes"
    }
  }
}
```

- **What is listed:** public, non-archived, non-fork repositories of the GitHub
  organization that carry the **`oss-project` topic** (opt-in, see below);
  every crate of the crates.io owner; every npm package of the maintainer except
  per-platform binaries (`…-linux-x64-gnu` and friends). Packages carry
  `publishedAt` (their latest publish) and `repo` when their metadata links to
  an organization repository — join them to `github` through it.
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
- **Size:** about 15 KB, 3 KB gzipped (28 projects, 18 crates, 92 npm packages,
  2026-09-24).

## Which repositories are projects

A repository is a project when it carries the GitHub topic `oss-project` —
set it in the repository's About box, no change here needed. The initial set
was every repository that released something in the six months before
2026-09-24 (a GitHub release, or a crates.io / npm publish linked to it):

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/tag-active-repos.ts           # dry run
GITHUB_TOKEN=$(gh auth token) node scripts/tag-active-repos.ts --apply   # add the topic
```

The script only adds the topic, never removes it; a project that goes dormant
loses it by hand. A repository that releases but is not a project (tooling such
as `standards`, `project-infra`) carries the blocker topic **`oss-exclude`**:
the tagger skips it, and the service never lists it, even if it also carries
`oss-project`.
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

## Hosting and rollout

Everything on Bunny is code in this repository and converges on every push to
`main` (`.github/workflows/deploy.yml`):

1. `pnpm check` — typecheck, tests, bundle.
2. `scripts/provision.ts` — finds or creates the edge script `oss-metrics` with
   its pull zone `sebastian-oss-metrics`; sets the script's variables and its
   `GITHUB_TOKEN` secret; pull zone caching (query strings ignored, Origin
   Shield, request coalescing, stale-while-updating); the edge rule that caches
   `/v1/` for an hour; the hostname `metrics.sebastian-software.com` with its free
   certificate and forced HTTPS. Stateless and idempotent: resources are looked
   up by name, settings written only when they differ — a second run changes
   nothing. The desired state is the `DESIRED` object at the top of the script.
3. `scripts/publish.ts` — uploads `dist/script.js`, publishes it as a release
   (noted with the commit), purges the pull zone.
4. `scripts/verify.ts` — smoke check against the `b-cdn.net` host (and the custom
   hostname once its certificate exists): `200`, CORS open, `schema: 1`, every
   source `ok`, and a repeat request served from the cache (`CDN-Cache: HIT`).
   A failed check fails the workflow.

### By hand, once

1. A Bunny account with billing, and its **API key**.
2. GitHub → Settings → Environments → **`production`** (restrict it to `main`),
   with the secrets `BUNNY_API_KEY` and `METRICS_GITHUB_TOKEN` (a fine-grained
   token with public read access only; it lifts GitHub's limit from 60 to 5,000
   requests an hour).
3. Run the workflow once; its summary prints the CNAME target. Point
   `metrics.sebastian-software.com` at it (`CNAME sebastian-oss-metrics.b-cdn.net`).
4. Run the workflow again after DNS has propagated: the certificate is issued
   and HTTPS forced. Until then the run passes with a warning.

Without `BUNNY_API_KEY` the rollout is skipped and the workflow stays green.
Locally: `BUNNY_API_KEY=… METRICS_GITHUB_TOKEN=… pnpm provision`, and
`pnpm verify https://sebastian-oss-metrics.b-cdn.net`.

## Cost

Bunny bills $1 a month minimum per account; at tens of thousands of page views
this service stays well inside it (bandwidth well under a gigabyte, Edge
Scripting $0.20 per million requests — mostly served from cache).

## License

Apache-2.0
