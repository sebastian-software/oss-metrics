# oss-metrics

Live public metrics for every Sebastian Software project — GitHub stars and
latest releases, crates.io and npm versions and downloads — as **one small JSON document**,
served from a Bunny edge script and cached at the edge for an hour.

Sites read one URL instead of calling GitHub, crates.io and npm from every
visitor's browser. The registries see bounded, cached collections instead of
per-visitor requests, each identified by a User-Agent as crates.io asks.

## Dashboard

The live dashboard is part of the [Open Source website](https://oss.sebastian-software.com/metrics),
with a [German version](https://oss.sebastian-software.de/metrics). Its source,
Sebastian theme, translations, build snapshot, and live refresh behavior live in
[`sebastian-websites/apps/opensource`](https://github.com/sebastian-software/sebastian-websites/tree/main/apps/opensource).
The OSS homepage shows a compact summary and links to the full directory.

This repository owns the public aggregate API and the legacy GitHub Pages
redirect. The browser receives only the public JSON; Rybbit credentials remain
in the Bunny runtime. npm monthly downloads and crates.io 30-day downloads
keep explicit time windows; crate lifetime and 90-day totals remain available.
The activity-proxy definition and coverage checks live alongside the dashboard.

`pnpm build:site` writes the redirect to `dist/site`, including a fallback link
and canonical URL. `pnpm preview:site` serves it at
`http://127.0.0.1:4173/oss-metrics/`. The Pages workflow publishes it independently
of Bunny. API source, type, runtime-script, or lockfile changes trigger Bunny;
workflow-only and secret-only changes require a manual Bunny deployment.

## Endpoint

`GET https://metrics.sebastian-software.com/v1/metrics.json`

```json
{
  "schema": 1,
  "generatedAt": "2026-09-24T10:00:00Z",
  "sources": { "github": "ok", "releases": "ok", "crates": "ok", "npm": "ok", "skills": "ok", "rybbit": "skipped" },
  "github": {
    "ferroni": {
      "stars": 7,
      "forks": 1,
      "language": "Rust",
      "pushedAt": "2026-09-24T19:00:00Z",
      "release": { "tag": "v1.5.1", "version": "1.5.1", "publishedAt": "2026-09-24T19:11:06Z" }
    }
  },
  "crates": {
    "ferroni": {
      "version": "1.4.2",
      "downloads": 1746,
      "recentDownloads": 1300,
      "downloads30Days": {
        "start": "2026-08-25T00:00:00.000Z",
        "end": "2026-09-24T00:00:00.000Z",
        "count": 500
      },
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
  },
  "skills": {
    "skills": { "effective-web": { "references": 133 } },
    "instructionPacks": 2
  },
  "usage": {}
}
```

- **What is listed:** public, non-archived, non-fork repositories of the GitHub
  organization that carry the **`oss-project` topic** (opt-in, see below);
  every crate of the crates.io owner; every npm package of the maintainer except
  per-platform binaries (`…-linux-x64-gnu` and friends). Every repository
  carries `pushedAt`, its last push. An archived repository drops out of the
  document, like one that loses the topic: a site that still lists it shows no
  live numbers for it. Packages carry
  `publishedAt` (their latest publish) and `repo` when their metadata links to
  an organization repository — join them to `github` through it.
  Ownership is implicit — each source is queried _by owner_, so a look-alike
  package somebody else published never appears.
- **Project language and Node.js bindings:** `github.<repo>.language` preserves
  GitHub's byte-based classification, or `null` when none is reported. An optional
  `coreLanguage` declares the language of the project's core. Maintainers set it
  with exactly one topic: `oss-language-rust`, `oss-language-typescript`,
  `oss-language-javascript`, `oss-language-c`, `oss-language-cpp`,
  `oss-language-python`, or `oss-language-go`. Consumers prefer `coreLanguage`
  and fall back to `language`; conflicting topics do not declare a core language.
  This uses the existing repository list without extra requests or registry
  inference. npm packages with explicit `napi`,
  `napi-rs`, `node-api`, or `n-api` keywords carry `nodeBinding: true`.
  Platform artifacts, including scoped names such as `@ferriki/linux-x64-gnu`,
  are excluded from the npm map and its totals. Ordinary CLI
  launchers and generic `native`/`rust` keywords do not establish a binding.
  Consumers join binding packages through their declared `repo` like other
  packages. Missing `nodeBinding` means no explicit declaration was found,
  rather than proof that native bindings do not exist. Both fields reuse the
  existing metadata requests and are additive schema-1 extensions.
- **Skills:** `skills` counts the agent skills of `skills.sebastian-software.com`
  (`SKILLS_REPO`): one entry per `skills/<name>/SKILL.md` with the number of
  `references/*.md` files, plus the number of `instructions/*.md` packs. The
  counts come from one recursive tree request on the default branch.
- **Five base upstream requests** per refresh (GitHub pages add one each per 100
  repositories): GitHub `orgs/{org}/repos`, one GitHub GraphQL query for every
  repository's latest release, the skills repository's tree, crates.io `crates?user_id=`, npm
  `-/v1/search?text=maintainer:`. The npm search carries versions and monthly
  downloads for scoped packages too.
- **crates.io 30-day downloads:** each crate also carries `downloads30Days`
  with an inclusive `start`, exclusive `end`, and nullable `count`. The window
  covers the last 30 complete UTC dates before `generatedAt`, excluding today's
  partial activity. The count sums daily downloads from the
  [crate downloads endpoint](https://github.com/rust-lang/crates.io/blob/main/src/controllers/krate/downloads.rs),
  including both `version_downloads` (the newest five versions) and
  `meta.extra_downloads` (all older versions). Missing zero-download dates add
  nothing. Registry ingestion can lag behind actual downloads.
  `downloads` still means lifetime downloads; `recentDownloads` still covers
  crates.io's 90-day window. The new field is an additive schema-1 extension.
  Failed or unattempted enrichment has `count: null`, preserving versions,
  repository links, and existing totals. Consumers must keep an aggregate
  unknown if any contributing crate has a null or absent count.
- **Bounded crate requests:** metadata and daily-statistics requests are
  serialized at least 1.1 seconds apart, following the
  [crates.io data access policy](https://crates.io/data-access). At most 30
  download lookups fit alongside the other bounded sources below Bunny's
  50-subrequest limit. A failed lookup stops enrichment; a six-second request
  timeout and 40-second collection deadline bound slow upstreams. Incomplete
  enrichment shortens the response cache to five minutes. A cold collection
  of the current 22 crates takes roughly 25 seconds; subsequent requests use
  the existing edge cache, origin shield, and request coalescing. Browser
  consumers should allow 45 seconds for a cold miss while retaining their
  previous snapshot.
- **Releases:** `github.<repo>.release` is the release GitHub marks "Latest"
  (no drafts, no prereleases), with `version` taken from the tag (`v0.3.0` and
  `ferrolex-v0.4.0` both give the plain version; a tag without semver is left
  out). It is the only version a Git-only tool has. GitHub's GraphQL API needs a
  token: without `GITHUB_TOKEN` the source reports `"skipped"` and the rest of
  the document is unaffected. Production gets the token from the Limen-encrypted
  `METRICS_GITHUB_TOKEN` (a fine-grained token with read access to public
  repositories is enough); the deploy's smoke check passes a skipped source
  with a notice.
- **A failing source** is reported in `sources` with an empty map; the others
  still answer, and the document is cached for five minutes instead of an hour.
  When nothing answers: `502`, not cached.
- **Caching:** `Cache-Control: public, max-age=300, s-maxage=3600`, plus the pull
  zone rules below. CORS is open (`Access-Control-Allow-Origin: *`).
- **Size:** about 15 KB, 3 KB gzipped (28 projects, 18 crates, 92 npm packages,
  2026-09-24).

## CLI usage from Rybbit

The optional `rybbit` source adds at most two authenticated aggregate requests
per refresh. It queries only `update_check` properties and publishes allowlisted
project totals in `usage`. It does not query raw events, visitors, sessions, or
user counts. Missing configuration or credentials gives `sources.rybbit:
"skipped"` and `usage: {}`. Authentication, timeout, malformed data, or query-limit
failures give `"error"` and an empty usage map; other sources remain available.

Example output with synthetic values:

```json
{
  "usage": {
    "palamedes": {
      "unit": "update_checks",
      "collectedAt": "2026-10-19T12:00:00Z",
      "verified": false,
      "windows": {
        "days7": {
          "start": "2026-10-12T00:00:00Z",
          "end": "2026-10-19T00:00:00Z",
          "count": 12,
          "observedCount": 12,
          "coverage": "complete",
          "observedFrom": "2026-10-12T00:00:00Z"
        },
        "days30": {
          "start": "2026-09-19T00:00:00Z",
          "end": "2026-10-19T00:00:00Z",
          "count": null,
          "observedCount": 30,
          "coverage": "partial",
          "observedFrom": "2026-10-01T00:00:00Z"
        }
      }
    }
  }
}
```

- `start` is inclusive and `end` exclusive. Both windows end at the start of
  the current UTC day, so today's partial activity is excluded.
- `count` is a number only for complete coverage. `observedCount` includes only
  the retained, eligible interval beginning at `observedFrom`. Partial coverage
  has `count: null`; unverified retention has `coverage: "unverified"` and
  `count: null`. Unavailable coverage has both counts and `observedFrom` set to
  `null`. A successful, complete empty result is zero.
- `collectedAt` belongs to this source observation. Cached responses retain it;
  there is no last-successful snapshot that gets a newer timestamp.
- Counts represent requests, including repeated checks and CI. They do not
  estimate distinct people, WAU/MAU, installations, or retention. Website copy
  belongs to the consumer; the API preserves the measured unit.
- `verified` defaults to `false`. Add a project to `verifiedProjects` only after
  its published client has been observed reaching Rybbit. Palamedes
  [#1036](https://github.com/sebastian-software/palamedes/issues/1036) owns that
  observation, and [#1277](https://github.com/sebastian-software/palamedes/issues/1277)
  owns website consumption. Consumers should hide unavailable/unverified values
  or make their state explicit.

### Private configuration

Set these two GitHub Actions secrets together:

- `METRICS_RYBBIT_API_KEY`: a dedicated integration key with the narrowest
  analytics read permissions supported by the deployed version. Never use the
  account login password as an API key.
- `METRICS_RYBBIT_CONFIG`: a JSON object in this form, using the actual private
  origin and numeric site ID. This example has no production identifiers:

Rybbit 2.6.0 inherits the key owner's organization permissions and does not
enforce analytics-only/read-only scopes. A separate integration key supports
independent revocation; it does not reduce those inherited permissions.

```json
{
  "endpoint": "https://analytics.example.invalid",
  "siteId": "42",
  "projects": ["palamedes"],
  "availableFrom": "2026-10-01",
  "retentionDays": 90,
  "verifiedProjects": []
}
```

`availableFrom` is the first complete UTC day of continuous, eligible collection,
after all known synthetic verification traffic. Verify that cutoff privately;
do not infer continuous coverage from the oldest visible event. Later synthetic
checks require moving the cutoff past them or a separately verified exclusion
mechanism. This first version excludes the entire earlier period instead of
subtracting unrelated property totals. Use a separate site for future synthetic
verification traffic when possible.

`retentionDays` is `null` until retention and continuous collection have been
verified. In that state the source still publishes observed counts, with
unverified coverage and no complete-window count. Set a numeric value only for
a verified lower bound on event retention in the actual deployment. It must not
be an assumption from upstream defaults. Rolling retention is
rounded inward to complete UTC days: a 30-day retention policy usually cannot
cover the last 30 **complete** days at midday.

Provisioning validates the pair and stores both values as Bunny runtime secrets
`RYBBIT_API_KEY` and `RYBBIT_CONFIG`. Neither value enters the public JSON or
bundle. Locally, set those runtime names to exercise `pnpm smoke`. Removing an
Actions secret does not delete its previously provisioned Bunny secret; disable
analytics explicitly by clearing the runtime configuration or deleting the two
runtime secrets in Bunny. A partial Actions configuration fails provisioning.

### API shape and rollout evidence

The implementation targets the properties response from Rybbit v2.6.0:
[`GET /api/sites/:site/events/properties`](https://rybbit.com/docs/api/events/properties),
with exact `event_name=update_check`, `time_zone=UTC`, and exclusive datetime
boundaries. That version's
[implementation](https://github.com/rybbit-io/rybbit/blob/v2.6.0/server/src/api/analytics/events/getEventProperties.ts)
has an unpaginated `LIMIT 500` across **all** property/value pairs. A result with
500 or more rows fails closed. Responses must contain only `data`, with unique
property/value pairs and safe nonnegative integer counts. The six properties
(`project`, `version`, `os`, `arch`, `mode`, `installedSince`) must have matching
total counts, or the event protocol is incomplete.

The source uses one five-second deadline for both requests, rejects redirects,
bounds each response to 256 KiB, and emits fixed errors without private upstream
details. No CI/local, version, platform, or cohort breakdowns are public.
Separate `project` and `mode` marginals do not establish their joint grouping.

Before enabling production, verify the deployed API version, Bearer auth, exact
event/time isolation, row limits, retention, clean-data cutoff, and allowlist.
Compare a complete UTC window against a private aggregate query and record only
aggregate counts, interval, collection time, and source/deploy revision. Current
upstream documentation alone is not deployment evidence. If a larger dataset
reaches the hard limit or needs joint property grouping, a private aggregate
export or a separately verified bounded reducer is needed; this collector never
silently truncates or falls back to raw-event pagination.

On 2026-10-19, the deployed Rybbit instance reported version 2.6.0. Private
read-only checks established successful login and Bearer authentication, an empty
aggregate for a nonexistent event, and rejection of a custom `project` filter
(HTTP 500). Both real responses were below the 500-row limit and had matching
totals for all six properties. The actual collector matched the private query:

| UTC start (inclusive) | UTC end (exclusive) | Observed Palamedes update checks |
| --- | --- | --- |
| 2026-10-12 00:00:00 | 2026-10-19 00:00:00 | 31 |
| 2026-09-19 00:00:00 | 2026-10-19 00:00:00 | 172 |

Retention and continuous historical collection were not independently verified,
so the initial private configuration uses `retentionDays: null` and
`verifiedProjects: []`. These observations prove that querying works; they do
not complete the published-client observation or establish complete coverage.
No raw events or provider identifiers are included in this evidence.

### Production verification on October 19, 2026

The source shipped in [PR #11](https://github.com/sebastian-software/oss-metrics/pull/11).
The current production deployment is
[`000db1f`](https://github.com/sebastian-software/oss-metrics/commit/000db1fe1aaa7564102f61769227cb7bd7cddafc),
with successful [CI (39 tests)](https://github.com/sebastian-software/oss-metrics/actions/runs/39296436626)
and [Bunny rollout and smoke checks](https://github.com/sebastian-software/oss-metrics/actions/runs/39296436694).
The Rybbit collector is unchanged from the initial integration.

The public snapshot collected at `2026-10-19T17:43:10.825Z` returned HTTP 200,
`sources.rybbit: "ok"`, and CORS access for website consumers. An authenticated
private aggregate recheck at `2026-10-19T17:45:17.925Z` matched both observed
Palamedes totals in the table above: 31 for October 12–18 and 172 for
September 19–October 18. The recheck used aggregate GET requests only.

This verifies the deployed query-to-public-snapshot path, not historical
completeness or a particular released client. Both windows still have
`coverage: "unverified"`, `count: null`, and project `verified: false`.
The public map contains only the allowlisted project and the documented
aggregate, unit, timestamp, and coverage fields. Credentials, private origin,
site configuration, raw properties, and visitor/session identifiers remain
outside the public response.

Two operational checks remain before a consumer can treat these as verified,
complete-window measurements:

1. Inspect the actual deployment's ClickHouse retention/deletion policy and
   continuous-collection history. Rybbit 2.6.0's analytics API and website
   settings do not establish either. An old retained event or a successful
   current aggregate is not evidence of uninterrupted historical collection.
2. Finish the published-client observation in
   [Palamedes #1036](https://github.com/sebastian-software/palamedes/issues/1036).
   Keep the clean-data cutoff and verification-traffic rule intact.

[Issue #10](https://github.com/sebastian-software/oss-metrics/issues/10) remains
open for these checks. [Palamedes #1277](https://github.com/sebastian-software/palamedes/issues/1277)
can use the source contract and rollout evidence, but must preserve the
unverified/partial/stale gates until the missing evidence is recorded.

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
   `/v1/metrics.json` for an hour; the hostname `metrics.sebastian-software.com` with its free
   certificate and forced HTTPS. Stateless and idempotent: resources are looked
   up by name, settings written only when they differ — a second run changes
   no infrastructure settings. Variables and secrets are idempotent upserts on
   every run. The desired state is the `DESIRED` object at the top of the script.
   Rybbit configuration and credentials are provisioned as runtime secrets when
   both optional Actions secrets described above are configured.
3. `scripts/publish.ts` — uploads `dist/script.js`, publishes it as a release
   (noted with the commit), purges the pull zone.
4. `scripts/verify.ts` — smoke check against the `b-cdn.net` host (and the custom
   hostname once its certificate exists): `200`, CORS open, `schema: 1`, every
   source `ok`, and a repeat request served from the cache (`CDN-Cache: HIT`).
   A failed check fails the workflow.

### Deployment credentials (GitHub Actions secrets)

The workflow reads `BUNNY_API_KEY` directly from the shared organization Actions secret.
Provisioning and publishing are restricted to `main`; the Bunny credential is passed only
to those two steps. No Limen policy, private action, install token, OIDC permission or
plaintext credential file is required in CI.

- `BUNNY_API_KEY` is the account key used for provisioning and publishing. Grant this
  repository access to the organization secret.
- `METRICS_GITHUB_TOKEN` remains an optional Actions secret: a fine-grained,
  public-read-only token can increase the GitHub API rate limit. Without it, the service
  uses public unauthenticated requests. Origin Shield and CDN caching reduce upstream
  traffic. Do not put the short-lived Actions `GITHUB_TOKEN` into the edge script: it
  expires when the workflow finishes.

A missing Bunny credential fails deployment. It is never reported as a successful
skipped rollout. For local deployment, set the same process environment variables or
use an ignored `.env.production.local` file:

```sh
node --env-file=.env.production.local scripts/provision.ts
```

The Bunny provision, publish and verification scripts and hosting configuration are
unchanged by the credential migration. The existing shared Limen installation and
other repositories that use it are unaffected.

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

## Screened app-usage observations

`GET /v1/app-usage.json` adapts app-tracking's fixed public monthly projection.
It stays separate from the cached registry and Rybbit metrics document. It
requires no database, maintainer-login, or reporting credentials. The source
and this response both use `no-store`; provisioning narrows the existing CDN
cache rule to `/v1/metrics.json`, excluding usage. Deployment purges old cached
responses. No prior snapshot is retained or served during an outage.

A disabled upstream returns 404 `not_enabled`; an unavailable, stale, malformed,
or unreviewed schema returns 503 `source_unavailable`. Neither means zero
usage. Successful responses preserve explicit unavailable months as null and
include the source snapshot time. Replace the whole snapshot on refresh and
clear its display on failure, withdrawal, or expiry; do not append old totals
or use a service-worker/offline cache for this route.

The unit is **reported observations**, rounded down to multiples of ten, over
complete UTC months. CLI invocations, verified resource downloads, and language
use are different measures. Legacy and generic streams, and local and CI modes,
remain separate. Do not add streams, infer people/physical devices, or relabel
these counts as registry downloads, update checks, or Rybbit visitors.
Installation/project IDs and unique counts, commands, versions, and system
breakdowns are excluded. Unknown upstream fields are dropped by reconstruction.

The app-tracking publication gate remains independent and disabled pending its
concrete disclosure assessment. Shipping this adapter does not activate it.
See [the source contract](https://github.com/sebastian-software/app-tracking/blob/main/docs/monthly-history.md).

## License

Apache-2.0
