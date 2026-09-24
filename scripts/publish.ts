/**
 * Uploads the bundled script, publishes it as a new release, and purges the
 * pull zone so the next request runs the new code.
 *
 *   BUNNY_API_KEY=… SCRIPT_ID=… PULL_ZONE_ID=… node scripts/publish.ts [dist/script.js]
 */
import { readFile } from "node:fs/promises";

import { type BunnyApi, bunnyApi, required } from "./bunny.ts";

export async function publish(
  api: BunnyApi,
  target: { scriptId: string; pullZoneId: string },
  code: string,
  note: string,
) {
  await api("POST", `/compute/script/${target.scriptId}/code`, { Code: code });
  await api("POST", `/compute/script/${target.scriptId}/publish`, { Note: note });
  await api("POST", `/pullzone/${target.pullZoneId}/purgeCache`, {});
}

if (import.meta.main) {
  const file = process.argv[2] ?? "dist/script.js";
  const code = await readFile(file, "utf8");
  const note = `${process.env.GITHUB_SHA?.slice(0, 7) ?? "local"} ${process.env.GITHUB_REF_NAME ?? ""}`.trim();
  await publish(
    bunnyApi(required("BUNNY_API_KEY")),
    { scriptId: required("SCRIPT_ID"), pullZoneId: required("PULL_ZONE_ID") },
    code,
    note,
  );
  console.log(`published ${file} (${code.length} bytes) as "${note}", cache purged`);
}
