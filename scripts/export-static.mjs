#!/usr/bin/env node
/**
 * Export the built doc site + a data dir's manifests as ONE self-contained
 * HTML file (no server needed): inlines the JS/CSS bundles and injects the
 * registry + doc models as a global, which flips the SPA into hash-routing
 * static mode (see packages/site/src/api.ts).
 *
 * Usage: node scripts/export-static.mjs <dataDir> <out.html> [--fragment]
 *   --fragment  omit <!doctype>/<html>/<head>/<body> wrappers (for hosts that
 *               provide their own document skeleton).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [dataDirArg, outArg, ...rest] = process.argv.slice(2);
if (!dataDirArg || !outArg) {
  console.error("usage: export-static.mjs <dataDir> <out.html> [--fragment]");
  process.exit(1);
}
const fragment = rest.includes("--fragment");
const dataDir = resolve(dataDirArg);
const siteDist = resolve(fileURLToPath(new URL("../packages/site/dist", import.meta.url)));

const registry = JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf8"));
const models = {};
for (const repo of registry.repos) {
  models[repo.slug] = JSON.parse(
    readFileSync(join(dataDir, "repos", repo.slug, "docmodel.json"), "utf8"),
  );
}

const assets = readdirSync(join(siteDist, "assets"));
const jsFile = assets.find((f) => f.endsWith(".js"));
const cssFile = assets.find((f) => f.endsWith(".css"));
if (!jsFile || !cssFile) throw new Error("site dist missing bundles — run `npm run build:site`");

// "</script" inside inlined JS/JSON would close the tag early; "<\/script" is
// byte-identical inside JS strings/regex, and < is safe in JSON. Literal
// U+FFFD chars (react-markdown's decoder keeps them in string literals) are
// emitted as escapes — some hosts reject raw U+FFFD as encoding corruption.
const js = readFileSync(join(siteDist, "assets", jsFile), "utf8")
  .replace(/<\/script/gi, "<\\/script")
  .replace(/�/g, "\\uFFFD");
const data = JSON.stringify({ registry, models })
  .replace(/</g, "\\u003c")
  .replace(/�/g, "\\uFFFD");
const css = readFileSync(join(siteDist, "assets", cssFile), "utf8");

const body = `<title>necronomidoc — ${registry.repos.map((r) => r.name).join(", ")}</title>
<style>${css}</style>
<div id="root"></div>
<script>window.__NECRO_DATA__=${data};</script>
<script type="module">${js}</script>`;

const html = fragment
  ? body
  : `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>\n<body>${body}</body>\n</html>`;

writeFileSync(resolve(outArg), html);
console.log(`✓ wrote ${outArg} (${(html.length / 1024).toFixed(0)} KB, ${registry.repos.length} repo(s))`);
