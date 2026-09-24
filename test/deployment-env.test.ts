import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentCredentials } from "../scripts/deployment-env.ts";

test("deployment imports only its two credentials, without evaluating dotenv as shell", () => {
  assert.deepEqual(deploymentCredentials('BUNNY_API_KEY="$(touch /tmp/not-run)"\nMETRICS_GITHUB_TOKEN=read-only\nUNRELATED=private'), {
    BUNNY_API_KEY: "$(touch /tmp/not-run)",
    METRICS_GITHUB_TOKEN: "read-only",
  });
});

test("public metrics can deploy without an optional GitHub token", () => {
  assert.deepEqual(deploymentCredentials("BUNNY_API_KEY=secret-value"), { BUNNY_API_KEY: "secret-value" });
});

test("missing or multiline credentials fail without exposing their values", () => {
  assert.throws(() => deploymentCredentials("METRICS_GITHUB_TOKEN=secret-value"), /BUNNY_API_KEY is missing/u);
  assert.throws(() => deploymentCredentials('BUNNY_API_KEY="secret\nINJECTED=value"\nMETRICS_GITHUB_TOKEN=token'), /BUNNY_API_KEY is missing or is not a single-line/u);
});
