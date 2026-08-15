import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSnapshotManifest, verifySnapshotManifest } from "./lib/snapshot-integrity.mjs";
import { DEFAULT_SURGE_DOMAIN, normalizeSurgeDomain } from "./lib/surge.mjs";
import {
  SITE_BUILD_FILE,
  createSiteBuildDescriptor,
  readSiteBuildDescriptor,
  stableSiteBuildJson,
} from "./lib/site-build.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(repoRoot, "dist");
const assetsDir = join(distDir, "assets");
const indexHtmlPath = join(distDir, "index.html");
const surgeFallbackPath = join(distDir, "200.html");
const surgeCnamePath = join(distDir, "CNAME");
const surgeDomain = normalizeSurgeDomain(process.env.SURGE_DOMAIN ?? DEFAULT_SURGE_DOMAIN);
const mirrorDataDir = join(distDir, "mirror-data");
const mirrorEntriesDir = join(mirrorDataDir, "entries");
const mirrorStatusPath = join(mirrorDataDir, "status.json");
const mirrorCatalogPath = join(mirrorDataDir, "catalog.json");
const mirrorSheetWorkbookPath = join(mirrorDataDir, "sheet-workbook.json");
const siteBuildPath = join(distDir, SITE_BUILD_FILE);

function fail(message) {
  console.error(`Frontend build verification failed: ${message}`);
  process.exit(1);
}

async function assertFile(path, label) {
  try {
    const result = await stat(path);
    if (!result.isFile()) {
      fail(`${label} exists but is not a file: ${path}`);
    }
  } catch {
    fail(`${label} is missing: ${path}`);
  }
}

async function assertDirectory(path, label) {
  try {
    const result = await stat(path);
    if (!result.isDirectory()) {
      fail(`${label} exists but is not a directory: ${path}`);
    }
  } catch {
    fail(`${label} is missing: ${path}`);
  }
}

function getAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ?? null;
}

function resolveDistAssetPath(src) {
  const cleanSrc = src.split(/[?#]/, 1)[0]?.replace(/^\/+/, "") ?? "";
  if (!cleanSrc.startsWith("assets/")) {
    fail(`module script does not point at dist/assets: ${src}`);
  }
  return join(distDir, cleanSrc);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJsonFile(path, label) {
  await assertFile(path, label);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await assertFile(indexHtmlPath, "dist/index.html");
await assertFile(surgeFallbackPath, "dist/200.html");
await assertFile(surgeCnamePath, "dist/CNAME");
await assertDirectory(assetsDir, "dist/assets");
await assertDirectory(mirrorDataDir, "dist/mirror-data");
await assertDirectory(mirrorEntriesDir, "dist/mirror-data/entries");

const [statusPayload, catalogPayload, sheetWorkbookPayload, mirrorEntryFiles] = await Promise.all([
  readJsonFile(mirrorStatusPath, "dist/mirror-data/status.json"),
  readJsonFile(mirrorCatalogPath, "dist/mirror-data/catalog.json"),
  readJsonFile(mirrorSheetWorkbookPath, "dist/mirror-data/sheet-workbook.json"),
  readdir(mirrorEntriesDir, { withFileTypes: true }),
]);

if (!statusPayload || typeof statusPayload !== "object") {
  fail("dist/mirror-data/status.json must contain a JSON object.");
}

if (!Array.isArray(catalogPayload?.items)) {
  fail("dist/mirror-data/catalog.json must contain an items array.");
}

if (!Array.isArray(sheetWorkbookPayload?.sheets)) {
  fail("dist/mirror-data/sheet-workbook.json must contain a sheets array.");
}

const entryJsonFiles = mirrorEntryFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
if (entryJsonFiles.length === 0) {
  fail("dist/mirror-data/entries does not contain any entry JSON files.");
}

try {
  const manifest = await readSnapshotManifest(mirrorDataDir);
  const verification = await verifySnapshotManifest(mirrorDataDir, manifest);
  if (statusPayload?.snapshot?.id !== verification.snapshotId) {
    fail("dist snapshot ID differs between status.json and manifest.json.");
  }
} catch (error) {
  fail(`dist mirror manifest verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const [storedSiteBuild, recomputedSiteBuild] = await Promise.all([
    readSiteBuildDescriptor(siteBuildPath),
    createSiteBuildDescriptor(distDir),
  ]);
  if (stableSiteBuildJson(storedSiteBuild) !== stableSiteBuildJson(recomputedSiteBuild)) {
    fail("dist/site-build.json does not match the deployable site contents.");
  }
} catch (error) {
  fail(`dist site build identity verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

const [indexHtml, surgeFallbackHtml, surgeCname, assetEntries] = await Promise.all([
  readFile(indexHtmlPath, "utf8"),
  readFile(surgeFallbackPath, "utf8"),
  readFile(surgeCnamePath, "utf8"),
  readdir(assetsDir, { withFileTypes: true }),
]);

if (surgeFallbackHtml !== indexHtml) {
  fail("dist/200.html must exactly match dist/index.html for Surge SPA routing.");
}
if (surgeCname.trim() !== surgeDomain) {
  fail(`dist/CNAME is ${JSON.stringify(surgeCname.trim())}, expected ${surgeDomain}.`);
}

const jsAssets = assetEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => entry.name)
  .sort();

if (jsAssets.length === 0) {
  fail("no JS assets found in dist/assets.");
}

const moduleScripts = [...indexHtml.matchAll(/<script\b[^>]*>/gi)]
  .map(([tag]) => ({ tag, type: getAttribute(tag, "type"), src: getAttribute(tag, "src") }))
  .filter((script) => script.type === "module" && script.src);

if (moduleScripts.length === 0) {
  fail("dist/index.html does not reference a module entry script.");
}

const entryPath = resolveDistAssetPath(moduleScripts[0].src);
const entryFile = basename(entryPath);

if (!jsAssets.includes(entryFile)) {
  fail(`entry script is missing from dist/assets: ${entryFile}`);
}

const sheetChunks = jsAssets.filter((asset) => asset.includes("sheet-workbook"));
if (sheetChunks.length === 0) {
  fail("no separate sheet-workbook JS chunk found in dist/assets.");
}

if (sheetChunks.includes(entryFile)) {
  fail("sheet-workbook chunk is also the main entry script.");
}

const entrySource = await readFile(entryPath, "utf8");

const dynamicImportFound = sheetChunks.some((chunk) => {
  const escapedChunk = escapeRegExp(chunk);
  return new RegExp(`import\\(\\s*["']\\./${escapedChunk}["']\\s*\\)`).test(entrySource);
});

if (!dynamicImportFound) {
  fail("main entry does not dynamically import the sheet-workbook chunk.");
}

const staticImportFound = sheetChunks.some((chunk) => {
  const escapedChunk = escapeRegExp(chunk);
  return (
    new RegExp(`\\bfrom\\s*["']\\./${escapedChunk}["']`).test(entrySource) ||
    new RegExp(`\\bimport\\s*["']\\./${escapedChunk}["']`).test(entrySource)
  );
});

if (staticImportFound) {
  fail("main entry statically imports the sheet-workbook chunk.");
}

console.log(
  `Frontend build verified: ${entryFile} lazy-loads ${sheetChunks.join(", ")}; copied mirror data verified.`,
);
