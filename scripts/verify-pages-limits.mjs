import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { listFiles } from "./lib/snapshot-integrity.mjs";

// Current Cloudflare Pages static asset limits. Environment overrides make the
// guard easy to tighten if the deployment target changes without editing code.
const DIST_DIR = resolve(process.env.PAGES_DIST_DIR ?? "dist");
const MAX_FILES = positiveInt(process.env.PAGES_MAX_FILES, 20_000);
const MAX_FILE_BYTES = positiveInt(process.env.PAGES_MAX_FILE_BYTES, 25 * 1024 * 1024);
const WARN_FILE_RATIO = 0.9;
const WARN_COUNT_RATIO = 0.9;

async function main() {
  const files = await listFiles(DIST_DIR);
  if (files.length > MAX_FILES) {
    throw new Error(`dist contains ${files.length} files; Pages limit is ${MAX_FILES}.`);
  }

  let largest = { path: "", bytes: 0 };
  let totalBytes = 0;
  for (const path of files) {
    const fileStat = await stat(resolve(DIST_DIR, path));
    totalBytes += fileStat.size;
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new Error(`${path} is ${formatBytes(fileStat.size)}; Pages per-file limit is ${formatBytes(MAX_FILE_BYTES)}.`);
    }
    if (fileStat.size > largest.bytes) largest = { path, bytes: fileStat.size };
  }

  if (files.length >= MAX_FILES * WARN_COUNT_RATIO) {
    console.warn(`WARN: dist is using ${files.length}/${MAX_FILES} allowed files.`);
  }
  if (largest.bytes >= MAX_FILE_BYTES * WARN_FILE_RATIO) {
    console.warn(`WARN: largest asset ${largest.path} is ${formatBytes(largest.bytes)} / ${formatBytes(MAX_FILE_BYTES)}.`);
  }

  console.log(
    `Cloudflare Pages preflight passed: ${files.length} files, ${formatBytes(totalBytes)} total; largest ${largest.path || "n/a"} (${formatBytes(largest.bytes)}).`,
  );
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let number = value / 1024;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit += 1; }
  return `${number.toFixed(number >= 10 ? 1 : 2)} ${units[unit]}`;
}

main().catch((error) => {
  console.error(`Cloudflare Pages preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
