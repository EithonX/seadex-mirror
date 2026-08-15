import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SURGE_DOMAIN, normalizeSurgeDomain } from "./lib/surge.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(repoRoot, process.env.SITE_DIST_DIR ?? process.env.PAGES_DIST_DIR ?? "dist");
const indexPath = resolve(distDir, "index.html");
const surgeFallbackPath = resolve(distDir, "200.html");
const surgeCnamePath = resolve(distDir, "CNAME");
const surgeDomain = normalizeSurgeDomain(process.env.SURGE_DOMAIN ?? DEFAULT_SURGE_DOMAIN);

// Vite can preserve source line endings in copied/static text files. A Windows
// checkout may therefore produce CRLF bytes while GitHub's Linux runners
// produce LF bytes from identical source. Normalize the deployable text files
// before fingerprinting so site identity is byte-stable across platforms.
for (const relativePath of ["index.html", "_headers", "_redirects"]) {
  const path = resolve(distDir, relativePath);
  try {
    const text = await readFile(path, "utf8");
    const normalized = normalizeLineEndings(text);
    if (normalized !== text) {
      await writeFile(path, normalized, "utf8");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const indexHtml = await readFile(indexPath, "utf8");
await writeFile(surgeFallbackPath, indexHtml, "utf8");
await writeFile(surgeCnamePath, `${surgeDomain}\n`, "utf8");

const fallbackHtml = await readFile(surgeFallbackPath, "utf8");
if (indexHtml !== fallbackHtml) {
  throw new Error("Surge SPA fallback differs from dist/index.html after copy.");
}

console.log(`Static host compatibility prepared: Surge SPA fallback + CNAME for ${surgeDomain}.`);

export function normalizeLineEndings(text) {
  return String(text).replace(/\r\n?/gu, "\n");
}
