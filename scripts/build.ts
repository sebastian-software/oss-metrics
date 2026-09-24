/**
 * Bundles the edge script into the one file Bunny's deploy action uploads.
 * The SDK stays external: the edge runtime provides it.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/script.ts"],
  outfile: "dist/script.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["@bunny.net/edgescript-sdk"],
  // `process.env` is how Bunny exposes the script's environment; keep it as is.
  logLevel: "info",
});
