/** Load only the deployment credentials, masking them before later steps run. */
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function deploymentCredentials(text: string): Record<string, string> {
  const parsed = parseEnv(text);
  const credentials: Record<string, string> = {};
  for (const name of ["BUNNY_API_KEY", "METRICS_GITHUB_TOKEN"]) {
    const value = parsed[name];
    if (name === "METRICS_GITHUB_TOKEN" && !value) continue;
    if (!value || /[\r\n]/u.test(value)) throw new Error(`${name} is missing or is not a single-line credential`);
    credentials[name] = value;
  }
  return credentials;
}

if (import.meta.main) {
  const file = ".env.production.local";
  chmodSync(file, 0o600);
  const credentials = deploymentCredentials(readFileSync(file, "utf8"));
  const output = process.env.GITHUB_ENV;
  if (!output) throw new Error("GITHUB_ENV is required; locally use node --env-file=.env.production.local");
  for (const value of Object.values(credentials)) {
    console.log(`::add-mask::${value.replaceAll("%", "%25")}`);
  }
  appendFileSync(output, Object.entries(credentials).map(([name, value]) => `${name}=${value}\n`).join(""));
  console.log("Loaded deployment credentials from Limen.");
}
