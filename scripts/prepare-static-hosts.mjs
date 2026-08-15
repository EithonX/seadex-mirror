import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SURGE_DOMAIN, normalizeSurgeDomain } from "./lib/surge.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(repoRoot, process.env.SITE_DIST_DIR ?? process.env.PAGES_DIST_DIR ?? "dist");
const indexPath = resolve(distDir, "index.html");
const surgeFallbackPath = resolve(distDir, "200.html");
const surgeCnamePath = resolve(distDir, "CNAME");
const surgeDomain = normalizeSurgeDomain(process.env.SURGE_DOMAIN ?? DEFAULT_SURGE_DOMAIN);

const indexHtml = await readFile(indexPath);
await copyFile(indexPath, surgeFallbackPath);
await writeFile(surgeCnamePath, `${surgeDomain}\n`, "utf8");

const fallbackHtml = await readFile(surgeFallbackPath);
if (!indexHtml.equals(fallbackHtml)) {
  throw new Error("Surge SPA fallback differs from dist/index.html after copy.");
}

console.log(`Static host compatibility prepared: Surge SPA fallback + CNAME for ${surgeDomain}.`);
