import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/snapshot-integrity.mjs";
import { DEFAULT_SURGE_DOMAIN, normalizeSurgeDomain } from "./lib/surge.mjs";

const MAX_FILES = 10_100;
const MAX_TOTAL_BYTES = 450_000_000;
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(repoRoot, process.env.SITE_DIST_DIR ?? process.env.PAGES_DIST_DIR ?? "dist");
const surgeDomain = normalizeSurgeDomain(process.env.SURGE_DOMAIN ?? DEFAULT_SURGE_DOMAIN);

const paths = await listFiles(distDir);
if (paths.length > MAX_FILES) {
  throw new Error(`Surge preflight failed: ${paths.length} files exceeds the ${MAX_FILES} file limit.`);
}

let totalBytes = 0;
let largest = { path: "", bytes: 0 };
for (const path of paths) {
  const fileStat = await stat(resolve(distDir, path));
  totalBytes += fileStat.size;
  if (fileStat.size > largest.bytes) largest = { path, bytes: fileStat.size };
}

if (totalBytes > MAX_TOTAL_BYTES) {
  throw new Error(
    `Surge preflight failed: ${formatBytes(totalBytes)} exceeds the ${formatBytes(MAX_TOTAL_BYTES)} project limit.`,
  );
}

const [indexHtml, fallbackHtml, cname] = await Promise.all([
  readFile(resolve(distDir, "index.html")),
  readFile(resolve(distDir, "200.html")),
  readFile(resolve(distDir, "CNAME"), "utf8"),
]);
if (!indexHtml.equals(fallbackHtml)) {
  throw new Error("Surge preflight failed: dist/200.html must exactly match dist/index.html.");
}
if (cname.trim() !== surgeDomain) {
  throw new Error(`Surge preflight failed: dist/CNAME is ${JSON.stringify(cname.trim())}, expected ${surgeDomain}.`);
}

console.log(
  `Surge preflight passed: ${paths.length} files, ${formatBytes(totalBytes)} total; ` +
  `largest ${largest.path} (${formatBytes(largest.bytes)}), domain ${surgeDomain}.`,
);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}
