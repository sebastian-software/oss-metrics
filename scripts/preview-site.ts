/** Local preview, including the GitHub Pages project subpath. No proxy or API. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve("dist/site");
const prefix = "/oss-metrics/";
const types: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml" };
createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (pathname === prefix.slice(0, -1)) {
      response.writeHead(302, { location: prefix }); response.end(); return;
    }
    if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length - 1);
    const file = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(404); response.end("Not found"); return; }
    const body = await readFile(file);
    response.writeHead(200, { "content-type": `${types[file.split(".").at(-1) ?? ""] ?? "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404); response.end("Not found"); }
}).listen(4173, "127.0.0.1", () => console.log("Local: http://127.0.0.1:4173/oss-metrics/"));
