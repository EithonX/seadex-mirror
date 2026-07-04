import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mirrorDataDir = join(projectRoot, "frontend", "public", "mirror-data");
const entriesDir = join(mirrorDataDir, "entries");
const failures = [];

async function main() {
  await assertDirectory(mirrorDataDir, "mirror data directory");

  const status = await readJson(join(mirrorDataDir, "status.json"));
  const catalog = await readJson(join(mirrorDataDir, "catalog.json"));
  const sheetWorkbook = await readJson(join(mirrorDataDir, "sheet-workbook.json"));

  validateStatus(status);
  validateCatalog(catalog);
  validateSheetWorkbook(sheetWorkbook);
  await validateEntries();

  if (failures.length) {
    console.error("Mirror data verification failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Mirror data verified.");
}

async function assertDirectory(path, label) {
  try {
    const result = await stat(path);
    if (!result.isDirectory()) {
      fail(`${label} exists but is not a directory: ${path}`);
    }
  } catch (error) {
    fail(`Missing ${label}: ${path}. Run npm run data:build first.`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Missing or invalid JSON: ${path}. Run npm run data:build first. ${formatError(error)}`);
    return null;
  }
}

function validateStatus(value) {
  if (!isRecord(value)) {
    fail("status.json must be a JSON object.");
    return;
  }
  if (!isRecord(value.counts) || !isPositiveNumber(value.counts.entries)) {
    fail("status.json must contain counts.entries as a number greater than 0.");
  }
  if (!isRecord(value.sync)) {
    fail("status.json must contain a sync object.");
  }
}

function validateCatalog(value) {
  if (!isRecord(value)) {
    fail("catalog.json must be a JSON object.");
    return;
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    fail("catalog.json must contain a non-empty items array.");
    return;
  }

  const firstItem = value.items[0];
  if (!isRecord(firstItem)) {
    fail("catalog.json first item must be an object.");
    return;
  }
  if (!Number.isFinite(firstItem.alId)) {
    fail("catalog.json first item must contain numeric alId.");
  }
  if (!hasDisplayTitle(firstItem)) {
    fail("catalog.json first item must contain titles.display.");
  }
}

function validateSheetWorkbook(value) {
  if (!isRecord(value)) {
    fail("sheet-workbook.json must be a JSON object.");
    return;
  }
  if (!Array.isArray(value.sheets) || value.sheets.length === 0) {
    fail("sheet-workbook.json must contain a non-empty sheets array.");
    return;
  }

  const firstSheet = value.sheets[0];
  if (!isRecord(firstSheet) || !Array.isArray(firstSheet.rows)) {
    fail("sheet-workbook.json first sheet must contain a rows array.");
  }
}

async function validateEntries() {
  await assertDirectory(entriesDir, "entries directory");

  let entryFiles = [];
  try {
    entryFiles = (await readdir(entriesDir)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    fail(`Unable to read entries directory: ${entriesDir}. ${formatError(error)}`);
    return;
  }

  if (entryFiles.length === 0) {
    fail(`entries directory must contain at least one .json file: ${entriesDir}`);
    return;
  }

  for (const file of entryFiles.slice(0, 3)) {
    validateEntry(await readJson(join(entriesDir, file)), file);
  }
}

function validateEntry(value, file) {
  if (!isRecord(value)) {
    fail(`${file} must be a JSON object.`);
    return;
  }

  const entry = isRecord(value.entry) ? value.entry : value;
  if (!Number.isFinite(entry.alId)) {
    fail(`${file} must contain numeric entry.alId.`);
  }
  if (!hasDisplayTitle(entry)) {
    fail(`${file} must contain entry.titles.display.`);
  }
  if (!Array.isArray(value.torrents)) {
    fail(`${file} must contain torrents array.`);
  }
}

function hasDisplayTitle(value) {
  return isRecord(value) && isRecord(value.titles) && isNonEmptyString(value.titles.display);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  failures.push(message);
}

main().catch((error) => {
  console.error(`Mirror data verification crashed: ${formatError(error)}`);
  process.exitCode = 1;
});
