/** Publishes only the legacy Pages redirect; the dashboard lives with the websites. */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist/site", { recursive: true, force: true });
await mkdir("dist/site", { recursive: true });
await Promise.all([
  copyFile("site/index.html", "dist/site/index.html"),
  copyFile("site/index.html", "dist/site/404.html"),
  copyFile("site/favicon.svg", "dist/site/favicon.svg"),
  writeFile("dist/site/.nojekyll", ""),
]);
