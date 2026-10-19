/** A static browser bundle; independent of the Bunny edge-script artifact. */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/site", { recursive: true });
await build({
  entryPoints: ["site/app.ts"], outfile: "dist/site/app.js", bundle: true,
  platform: "browser", format: "esm", target: "es2022", minify: true, logLevel: "info",
});
await Promise.all([
  copyFile("site/index.html", "dist/site/index.html"),
  copyFile("site/favicon.svg", "dist/site/favicon.svg"),
  writeFile("dist/site/.nojekyll", ""),
]);
