import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(repoRoot, "dist");
const assetsDir = join(distDir, "assets");
const indexHtmlPath = join(distDir, "index.html");

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

await assertFile(indexHtmlPath, "dist/index.html");
await assertDirectory(assetsDir, "dist/assets");

const [indexHtml, assetEntries] = await Promise.all([
  readFile(indexHtmlPath, "utf8"),
  readdir(assetsDir, { withFileTypes: true }),
]);

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

console.log(`Frontend build verified: ${entryFile} lazy-loads ${sheetChunks.join(", ")}.`);
