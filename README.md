# oss-metrics

Live public metrics for every Sebastian Software project — GitHub stars and
latest releases, crates.io and npm versions and downloads — as **one small JSON document**,
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
  "sources": { "github": "ok", "releases": "ok", "crates": "ok", "npm": "ok" },
  "github": {
    "ferroni": {
      "stars": 7,
      "forks": 1,
      "release": { "tag": "v1.5.1", "version": "1.5.1", "publishedAt": "2026-09-24T19:11:06Z" }
    }
  },
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
- **Four upstream requests** per refresh (GitHub pages add one each per 100
  repositories): GitHub `orgs/{org}/repos`, one GitHub GraphQL query for every
  repository's latest release, crates.io `crates?user_id=`, npm
  `-/v1/search?text=maintainer:`. The npm search carries versions and monthly
  downloads for scoped packages too.
- **Releases:** `github.<repo>.release` is the release GitHub marks "Latest"
  (no drafts, no prereleases), with `version` taken from the tag (`v0.3.0` and
  `ferrolex-v0.4.0` both give the plain version; a tag without semver is left
  out). It is the only version a Git-only tool has. GitHub's GraphQL API needs a
  token: without `GITHUB_TOKEN` the source reports `"skipped"` and the rest of
  the document is unaffected.
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
   optional `GITHUB_TOKEN` secret; pull zone caching (query strings ignored, Origin
   Shield, request coalescing, stale-while-updating); the edge rule that caches
   `/v1/` for an hour; the hostname `metrics.sebastian-software.com` with its free
   certificate and forced HTTPS. Stateless and idempotent: resources are looked
   up by name, settings written only when they differ — a second run changes
   no infrastructure settings. Variables and secrets are idempotent upserts on
   every run. The desired state is the `DESIRED` object at the top of the script.
3. `scripts/publish.ts` — uploads `dist/script.js`, publishes it as a release
   (noted with the commit), purges the pull zone.
4. `scripts/verify.ts` — smoke check against the `b-cdn.net` host (and the custom
   hostname once its certificate exists): `200`, CORS open, `schema: 1`, every
   source `ok`, and a repeat request served from the cache (`CDN-Cache: HIT`).
   A failed check fails the workflow.

### Deployment credentials (Limen / SOPS)

The workflow decrypts `.limen/production/.env.production.local.sops.env` through
Limen using GitHub OIDC. `.limen.yaml` maps it to the ignored
`.env.production.local`; that file is restricted to mode `0600`, its credentials
are masked before use, and the workflow removes it on completion. Only
`BUNNY_API_KEY` and the optional `METRICS_GITHUB_TOKEN` are imported.

- `BUNNY_API_KEY` is the account key used for provisioning and publishing.
- `METRICS_GITHUB_TOKEN` may be a fine-grained, public-read-only token to increase
  the GitHub API rate limit. Without it, the service uses public unauthenticated
  requests. Origin Shield and CDN caching reduce upstream traffic. Do not put a
  short-lived Actions `GITHUB_TOKEN` into the edge script: it expires when the
  workflow finishes.
- The only GitHub secret needed is the existing organization secret
  `LIMEN_INSTALL_TOKEN`, with repository access granted to `oss-metrics`. It
  downloads the private Limen action and CLI. The public workflow checks out the
  action at a pinned commit rather than using a private action directly.
- Limen's allowlist is restricted to `sebastian-software/oss-metrics`,
  `refs/heads/main`, the `deploy.yml` workflow on `main`, and the GitHub
  Environment `production`. The Environment allows only the `main` branch.

A missing install token, a denied OIDC request, or a missing Bunny credential
fails the deployment. It is never reported as a successful skipped rollout.

For local deployment or credential updates, install Limen and SOPS, then:

```sh
limen login
limen sync                   # also registers local merge/diff drivers
limen decrypt --env production
node --env-file=.env.production.local scripts/provision.ts
# Edit the encrypted file through Limen; never commit plaintext.
limen edit .limen/production/.env.production.local.sops.env
limen sync --check
```

The DNS record is `metrics.sebastian-software.com CNAME
sebastian-oss-metrics.b-cdn.net` (TTL 300). The provisioner retries certificate
issuance after DNS propagation and then forces HTTPS. Bunny's script API returns
its default `bunny.run` address as a complete URL; workflow outputs deliberately
use the bare `b-cdn.net` hostname for both verification and the CNAME target.

The initial live rollout verified the SDK import, runtime environment variables,
integer edge-rule enums, all three data sources, CORS, `CDN-Cache: HIT`, and the
custom hostname with HTTPS. Re-run the workflow after changing any source or
hosting configuration; it publishes the bundle and purges the cache.

## Cost

Bunny bills $1 a month minimum per account; at tens of thousands of page views
this service stays well inside it (bandwidth well under a gigabyte, Edge
Scripting $0.20 per million requests — mostly served from cache).

## License

Apache-2.0
