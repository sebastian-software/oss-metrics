import assert from "node:assert/strict";
import { test } from "node:test";

import { type BunnyApi, BunnyError } from "../scripts/bunny.ts";
import { DESIRED, provision } from "../scripts/provision.ts";
import { publish } from "../scripts/publish.ts";

type Call = { method: string; path: string; body?: unknown };

/**
 * An in-memory Bunny account: just enough state for the provisioning flow,
 * answering the way the API reference describes.
 */
function fakeBunny(options: { dnsReady?: boolean } = {}) {
  const calls: Call[] = [];
  const state = {
    scripts: [] as { Id: number; Name: string; LinkedPullZones: { Id: number; PullZoneName: string }[] }[],
    pullZone: {
      Id: 900,
      Name: "",
      IgnoreQueryStrings: false,
      EnableOriginShield: false,
      OriginShieldZoneCode: "",
      EnableRequestCoalescing: false,
      UseStaleWhileUpdating: false,
      Hostnames: [] as { Value: string; HasCertificate: boolean; ForceSSL: boolean }[],
      EdgeRules: [] as Record<string, unknown>[],
    } as Record<string, unknown> & {
      Hostnames: { Value: string; HasCertificate: boolean; ForceSSL: boolean }[];
      EdgeRules: Record<string, unknown>[];
    },
    variables: new Map<string, string>(),
    secrets: new Map<string, string>(),
  };

  const api: BunnyApi = async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const payload = body as Record<string, unknown>;
    const route = `${method} ${path.split("?")[0]}`;
    if (route === "GET /compute/script") return { Items: state.scripts } as T;
    if (route === "POST /compute/script") {
      const zoneName = String(payload.LinkedPullZoneName);
      state.pullZone.Name = zoneName;
      const script = { Id: 42, Name: String(payload.Name), LinkedPullZones: [{ Id: 900, PullZoneName: zoneName }] };
      state.scripts.push(script);
      return script as T;
    }
    if (route === "PUT /compute/script/42/variables") {
      state.variables.set(String(payload.Name), String(payload.DefaultValue));
      return undefined as T;
    }
    if (route === "PUT /compute/script/42/secrets") {
      state.secrets.set(String(payload.Name), String(payload.Secret));
      return undefined as T;
    }
    if (route === "GET /pullzone/900") return structuredClone(state.pullZone) as T;
    if (route === "POST /pullzone/900") {
      Object.assign(state.pullZone, payload);
      return undefined as T;
    }
    if (route === "POST /pullzone/900/edgerules/addOrUpdate") {
      const index = state.pullZone.EdgeRules.findIndex((rule) => rule.Guid === payload.Guid);
      if (index === -1) state.pullZone.EdgeRules.push({ ...payload, Guid: "rule-1" });
      else state.pullZone.EdgeRules[index] = { ...payload };
      return undefined as T;
    }
    if (route === "POST /pullzone/900/addHostname") {
      state.pullZone.Hostnames.push({ Value: String(payload.Hostname), HasCertificate: false, ForceSSL: false });
      return undefined as T;
    }
    if (route === "GET /pullzone/loadFreeCertificate") {
      if (!options.dnsReady) throw new BunnyError(400, path, "The domain is not pointing to our servers.");
      state.pullZone.Hostnames[0].HasCertificate = true;
      return undefined as T;
    }
    if (route === "POST /pullzone/900/setForceSSL") {
      state.pullZone.Hostnames[0].ForceSSL = Boolean(payload.ForceSSL);
      return undefined as T;
    }
    if (method === "POST" && /^\/(?:compute\/script\/42\/(?:code|publish)|pullzone\/900\/purgeCache)$/u.test(path)) {
      return undefined as T;
    }
    throw new Error(`unexpected ${route}`);
  };
  return { api, calls, state };
}

const writes = (calls: Call[]) =>
  calls.filter((call) => call.method !== "GET" && !/\/(?:variables|secrets)$/u.test(call.path)).map((call) => `${call.method} ${call.path}`);

test("an empty account converges on the full hosting", async () => {
  const bunny = fakeBunny({ dnsReady: true });
  const result = await provision(bunny.api, DESIRED, { GITHUB_TOKEN: "ghp_secret" });

  assert.equal(result.scriptId, 42);
  assert.equal(result.pullZoneId, 900);
  assert.equal(result.pullZoneHost, "sebastian-oss-metrics.b-cdn.net");
  assert.equal(result.customHostReady, true);
  assert.equal(bunny.state.variables.get("GITHUB_TOPIC"), "oss-project");
  assert.equal(bunny.state.secrets.get("GITHUB_TOKEN"), "ghp_secret");
  assert.equal(bunny.state.pullZone.IgnoreQueryStrings, true);
  assert.equal(bunny.state.pullZone.EnableOriginShield, true);
  assert.equal(bunny.state.pullZone.EdgeRules.length, 1);
  assert.equal(bunny.state.pullZone.EdgeRules[0].ActionParameter1, "3600");
  assert.deepEqual(bunny.state.pullZone.Hostnames, [
    { Value: "metrics.sebastian-software.com", HasCertificate: true, ForceSSL: true },
  ]);
  assert.ok(result.changes.some((change) => change.startsWith("created script")));
});

test("a second run changes nothing", async () => {
  const bunny = fakeBunny({ dnsReady: true });
  await provision(bunny.api, DESIRED, { GITHUB_TOKEN: "ghp_secret" });
  bunny.calls.length = 0;

  const again = await provision(bunny.api, DESIRED, { GITHUB_TOKEN: "ghp_secret" });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(writes(bunny.calls), [], "no create, settings, rule, hostname or certificate writes");
  assert.equal(bunny.state.scripts.length, 1);
  assert.equal(bunny.state.pullZone.EdgeRules.length, 1);
});

test("a changed rule is updated in place, keeping its Guid", async () => {
  const bunny = fakeBunny({ dnsReady: true });
  await provision(bunny.api, DESIRED, {});
  const longer = structuredClone(DESIRED);
  longer.edgeRules[0].ActionParameter1 = "7200";

  const result = await provision(bunny.api, longer, {});
  assert.deepEqual(result.changes, ['updated edge rule "oss-metrics: cache /v1/ for an hour"']);
  assert.equal(bunny.state.pullZone.EdgeRules.length, 1);
  assert.equal(bunny.state.pullZone.EdgeRules[0].Guid, "rule-1");
  assert.equal(bunny.state.pullZone.EdgeRules[0].ActionParameter1, "7200");
});

test("without DNS the certificate waits: a warning, no forced HTTPS, retried next run", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const bunny = fakeBunny({ dnsReady: false });
  const result = await provision(bunny.api, DESIRED, {});

  assert.equal(result.customHostReady, false);
  assert.ok(!bunny.calls.some((call) => call.path.endsWith("/setForceSSL")));
  assert.ok(log.mock.calls.some((call) => String(call.arguments[0]).startsWith("::warning::")));
  assert.ok(
    log.mock.calls.every((call) => !String(call.arguments[0]).includes("ghp_")),
    "no secret in the log",
  );
});

test("any other certificate error fails the run", async () => {
  const bunny = fakeBunny({ dnsReady: true });
  const failing: BunnyApi = async (method, path, body) => {
    if (path.startsWith("/pullzone/loadFreeCertificate")) throw new BunnyError(500, path, "boom");
    return bunny.api(method, path, body);
  };
  await assert.rejects(provision(failing, DESIRED, {}), /answered 500/u);
});

test("publish uploads, releases and purges, in that order", async () => {
  const bunny = fakeBunny();
  await publish(bunny.api, { scriptId: "42", pullZoneId: "900" }, "export {};", "abc1234 main");
  assert.deepEqual(
    bunny.calls.map((call) => `${call.method} ${call.path}`),
    ["POST /compute/script/42/code", "POST /compute/script/42/publish", "POST /pullzone/900/purgeCache"],
  );
  assert.deepEqual(bunny.calls[1].body, { Note: "abc1234 main" });
});
