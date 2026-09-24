/**
 * Converges the Bunny account on the hosting this service needs: the edge
 * script with its linked pull zone, the script's configuration, the pull zone's
 * caching, the edge rule, and the custom hostname with its free certificate.
 *
 * Idempotent and stateless: every resource is looked up by name before it is
 * created, and a setting is only written when it differs. A second run changes
 * nothing. Nothing secret is logged.
 *
 *   BUNNY_API_KEY=… METRICS_GITHUB_TOKEN=… node scripts/provision.ts
 */
import { type BunnyApi, bunnyApi, BunnyError, required, setOutputs } from "./bunny.ts";

/** Everything the hosting consists of, as data. */
export const DESIRED = {
  scriptName: "oss-metrics",
  /** Also the `<name>.b-cdn.net` host, so it has to be unique across Bunny. */
  pullZoneName: "sebastian-oss-metrics",
  hostname: "metrics.sebastian-software.com",
  variables: {
    GITHUB_ORG: "sebastian-software",
    GITHUB_TOPIC: "oss-project",
    GITHUB_EXCLUDE_TOPIC: "oss-exclude",
    CRATES_USER_ID: "385008",
    NPM_MAINTAINER: "swernerx",
  } as Record<string, string>,
  pullZone: {
    // The endpoint takes no query: a random query string must not bypass the cache.
    IgnoreQueryStrings: true,
    EnableOriginShield: true,
    OriginShieldZoneCode: "FR",
    EnableRequestCoalescing: true,
    UseStaleWhileUpdating: true,
  } as Record<string, unknown>,
  edgeRules: [
    {
      // Standalone scripts run after the cache, and Bunny's smart cache does not
      // cache JSON on its own: this rule is what makes the document cached.
      Description: "oss-metrics: cache /v1/ for an hour",
      Enabled: true,
      ActionType: 3, // OverrideCacheTime
      ActionParameter1: "3600",
      ActionParameter2: "",
      ActionParameter3: "",
      ExtraActions: [],
      TriggerMatchingType: 0, // MatchAny
      Triggers: [{ Type: 0, PatternMatchingType: 0, PatternMatches: ["*/v1/*"] }], // Url, MatchAny
    },
  ],
};

export type Desired = typeof DESIRED;

type LinkedPullZone = { Id: number; PullZoneName: string; DefaultHostname?: string };
type Script = { Id: number; Name: string; LinkedPullZones?: LinkedPullZone[] | null };
type Hostname = { Value: string; HasCertificate: boolean; ForceSSL: boolean };
type EdgeRule = Record<string, unknown> & { Guid?: string; Description?: string };
type PullZone = Record<string, unknown> & {
  Id: number;
  Name: string;
  Hostnames?: Hostname[];
  EdgeRules?: EdgeRule[];
  Edgerules?: EdgeRule[];
};

export type ProvisionResult = {
  scriptId: number;
  pullZoneId: number;
  pullZoneHost: string;
  customHostReady: boolean;
  changes: string[];
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of an edge rule this script owns, in a comparable order. */
const ruleShape = (rule: EdgeRule) => ({
  Enabled: rule.Enabled,
  ActionType: rule.ActionType,
  ActionParameter1: rule.ActionParameter1,
  TriggerMatchingType: rule.TriggerMatchingType,
  Triggers: (rule.Triggers as { Type: unknown; PatternMatchingType: unknown; PatternMatches: unknown }[] | undefined)?.map(
    (trigger) => ({
      Type: trigger.Type,
      PatternMatchingType: trigger.PatternMatchingType,
      PatternMatches: trigger.PatternMatches,
    }),
  ),
});

async function findScript(api: BunnyApi, name: string): Promise<Script | undefined> {
  const query = `search=${encodeURIComponent(name)}&type=1&includeLinkedPullzones=true&perPage=100`;
  const page = await api<{ Items?: Script[] }>("GET", `/compute/script?${query}`);
  return page.Items?.find((script) => script.Name === name);
}

export async function provision(
  api: BunnyApi,
  desired: Desired,
  secrets: Record<string, string>,
): Promise<ProvisionResult> {
  const changes: string[] = [];

  // 1. The script, with its linked pull zone.
  let script = await findScript(api, desired.scriptName);
  if (script === undefined) {
    script = await api<Script>("POST", "/compute/script", {
      Name: desired.scriptName,
      Code: "export {};",
      ScriptType: 1, // Standalone (CDN)
      CreateLinkedPullZone: true,
      LinkedPullZoneName: desired.pullZoneName,
    });
    changes.push(`created script ${desired.scriptName} (${script.Id})`);
  }
  const linked = script.LinkedPullZones?.[0] ?? (await api<Script>("GET", `/compute/script/${script.Id}`)).LinkedPullZones?.[0];
  if (linked === undefined) throw new Error(`script ${script.Id} has no linked pull zone`);

  // 2. Configuration: upserts, cheap and idempotent. Secret values cannot be read back.
  for (const [Name, DefaultValue] of Object.entries(desired.variables)) {
    await api("PUT", `/compute/script/${script.Id}/variables`, { Name, Required: false, DefaultValue });
  }
  for (const [Name, Secret] of Object.entries(secrets)) {
    await api("PUT", `/compute/script/${script.Id}/secrets`, { Name, Secret });
  }

  // 3. Pull zone settings, written only when one differs.
  let pullZone = await api<PullZone>("GET", `/pullzone/${linked.Id}`);
  const drift = Object.entries(desired.pullZone).filter(([key, value]) => !sameJson(pullZone[key], value));
  if (drift.length > 0) {
    await api("POST", `/pullzone/${linked.Id}`, Object.fromEntries(drift));
    changes.push(`pull zone settings: ${drift.map(([key]) => key).join(", ")}`);
  }

  // 4. Edge rules, matched by description; the existing Guid makes it an update.
  const existingRules = pullZone.EdgeRules ?? pullZone.Edgerules ?? [];
  for (const rule of desired.edgeRules) {
    const current = existingRules.find((candidate) => candidate.Description === rule.Description);
    if (current !== undefined && sameJson(ruleShape(current), ruleShape(rule))) continue;
    await api("POST", `/pullzone/${linked.Id}/edgerules/addOrUpdate`, {
      ...rule,
      ...(current?.Guid ? { Guid: current.Guid } : {}),
    });
    changes.push(`${current ? "updated" : "added"} edge rule "${rule.Description}"`);
  }

  // 5. Custom hostname and its free certificate. The certificate needs the
  //    CNAME in place; until it resolves, that is a warning, retried next run.
  const host = () =>
    pullZone.Hostnames?.find((entry) => entry.Value.toLowerCase() === desired.hostname.toLowerCase());
  if (host() === undefined) {
    await api("POST", `/pullzone/${linked.Id}/addHostname`, { Hostname: desired.hostname });
    changes.push(`added hostname ${desired.hostname}`);
    pullZone = await api<PullZone>("GET", `/pullzone/${linked.Id}`);
  }
  let customHostReady = host()?.HasCertificate === true;
  if (!customHostReady) {
    try {
      await api("GET", `/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(desired.hostname)}`);
      changes.push(`issued certificate for ${desired.hostname}`);
      customHostReady = true;
    } catch (error) {
      if (!(error instanceof BunnyError) || error.status !== 400) throw error;
      console.log(
        `::warning::No certificate for ${desired.hostname} yet (${error.detail}). ` +
          `Point a CNAME at ${linked.PullZoneName}.b-cdn.net; the next run retries.`,
      );
    }
  }
  if (customHostReady && host()?.ForceSSL !== true) {
    await api("POST", `/pullzone/${linked.Id}/setForceSSL`, { Hostname: desired.hostname, ForceSSL: true });
    changes.push(`forced HTTPS on ${desired.hostname}`);
  }

  return {
    scriptId: script.Id,
    pullZoneId: linked.Id,
    pullZoneHost: linked.DefaultHostname ?? `${linked.PullZoneName}.b-cdn.net`,
    customHostReady,
    changes,
  };
}

if (import.meta.main) {
  const api = bunnyApi(required("BUNNY_API_KEY"));
  const result = await provision(api, DESIRED, { GITHUB_TOKEN: required("METRICS_GITHUB_TOKEN") });
  console.log(result.changes.length > 0 ? result.changes.map((change) => `- ${change}`).join("\n") : "no changes");
  await setOutputs({
    script_id: String(result.scriptId),
    pull_zone_id: String(result.pullZoneId),
    pull_zone_host: result.pullZoneHost,
    custom_host_ready: String(result.customHostReady),
  });
}
