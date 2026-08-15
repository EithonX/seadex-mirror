import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSnapshotManifest, verifySnapshotManifest } from "./lib/snapshot-integrity.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mirrorDataDir = join(projectRoot, "frontend", "public", "mirror-data");
const entriesDir = join(mirrorDataDir, "entries");
const failures = [];

async function main() {
  await assertDirectory(mirrorDataDir, "mirror data directory");

  const [status, catalog, sheet, sheetWorkbook, aniListCache] = await Promise.all([
    readJson(join(mirrorDataDir, "status.json")),
    readJson(join(mirrorDataDir, "catalog.json")),
    readJson(join(mirrorDataDir, "sheet.json")),
    readJson(join(mirrorDataDir, "sheet-workbook.json")),
    readJson(join(mirrorDataDir, "anilist-cache.json")),
  ]);

  await validateManifest(status);
  validateStatus(status);
  validateCatalog(catalog);
  validateSheet(sheet);
  validateSheetWorkbook(sheetWorkbook);
  validateAniListCache(aniListCache, status, catalog);
  validateCrossFileSets(catalog, sheet);
  await validateEntries(status, catalog, sheet);

  if (failures.length) {
    console.error("Mirror data verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Mirror data verified: snapshot ${status.snapshot.id.slice(0, 12)}, ${status.counts.entries} entries, ${status.counts.torrents} torrents.`,
  );
}

async function validateManifest(status) {
  try {
    const manifest = await readSnapshotManifest(mirrorDataDir);
    const result = await verifySnapshotManifest(mirrorDataDir, manifest);
    if (status?.snapshot?.id && result.snapshotId !== status.snapshot.id) {
      fail("manifest.json snapshotId does not match status.json.");
    }
    if (status?.snapshot?.sourceFingerprint && result.sourceFingerprint !== status.snapshot.sourceFingerprint) {
      fail("manifest.json sourceFingerprint does not match status.json.");
    }
  } catch (error) {
    fail(`Snapshot manifest verification failed: ${formatError(error)}`);
  }
}

function validateStatus(value) {
  if (!isRecord(value)) return fail("status.json must be a JSON object.");
  if (!isRecord(value.snapshot)) fail("status.json must contain snapshot metadata.");
  if (!/^[a-f0-9]{64}$/u.test(String(value.snapshot?.id ?? ""))) fail("status.snapshot.id must be SHA-256 hex.");
  if (!/^[a-f0-9]{64}$/u.test(String(value.snapshot?.sourceFingerprint ?? ""))) {
    fail("status.snapshot.sourceFingerprint must be SHA-256 hex.");
  }
  if (!isRecord(value.counts) || !isPositiveInteger(value.counts.entries)) {
    fail("status.counts.entries must be a positive integer.");
  }
  if (!isRecord(value.counts) || !isNonNegativeInteger(value.counts.torrents)) {
    fail("status.counts.torrents must be a non-negative integer.");
  }
  if (!isRecord(value.integrity)) fail("status.json must contain integrity metadata.");
  if (value.integrity?.listIdParity !== "match") fail("status integrity list-ID parity is not 'match'.");
  if (value.integrity?.expandedTorrentParity !== "match") fail("status expanded torrent parity is not 'match'.");
  if (!isRecord(value.sync)) fail("status.json must contain a sync object.");
}

function validateCatalog(value) {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) {
    fail("catalog.json must contain a non-empty items array.");
    return;
  }
  assertUniqueNumericIds(value.items, "alId", "catalog.json");
  for (const item of value.items) {
    if (!isRecord(item) || !isNonEmptyString(item?.titles?.display)) {
      fail(`catalog.json item ${item?.alId ?? "unknown"} is missing titles.display.`);
    }
    if (!isNonNegativeInteger(item?.torrentCount) || !isNonNegativeInteger(item?.bestTorrentCount)) {
      fail(`catalog.json item ${item?.alId ?? "unknown"} has invalid torrent counts.`);
    }
  }
}

function validateSheet(value) {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) {
    fail("sheet.json must contain a non-empty items array.");
    return;
  }
  assertUniqueNumericIds(value.items, "alId", "sheet.json");
}

function validateSheetWorkbook(value) {
  if (!isRecord(value) || !Array.isArray(value.sheets) || value.sheets.length === 0) {
    fail("sheet-workbook.json must contain a non-empty sheets array.");
    return;
  }
  for (const sheet of value.sheets) {
    if (!isRecord(sheet) || !isNonEmptyString(sheet.name) || !Array.isArray(sheet.rows)) {
      fail("sheet-workbook.json contains an invalid sheet record.");
    }
  }
}

function validateAniListCache(value, status, catalog) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    fail("anilist-cache.json must contain an items array.");
    return;
  }
  const ids = new Set();
  const catalogIds = new Set((catalog?.items ?? []).map((item) => item.alId));
  for (const item of value.items) {
    const media = isRecord(item?.media) ? item.media : item;
    const id = media?.id;
    if (!isPositiveInteger(id)) {
      fail("anilist-cache.json contains a record without a valid media ID.");
      continue;
    }
    if (ids.has(id)) fail(`anilist-cache.json contains duplicate media ID ${id}.`);
    ids.add(id);
    if (isRecord(item?.media) && !Number.isFinite(Date.parse(item.fetchedAt ?? ""))) {
      fail(`anilist-cache.json media ID ${id} has an invalid fetchedAt timestamp.`);
    }
    if (!catalogIds.has(id)) {
      fail(`anilist-cache.json contains media ID ${id} that is not in the active catalog.`);
    }
  }
  if (ids.size !== status?.counts?.anilistMedia) {
    fail(`anilist-cache.json has ${ids.size} active media records; status reports ${status?.counts?.anilistMedia}.`);
  }
}

function validateCrossFileSets(catalog, sheet) {
  const catalogIds = new Set((catalog?.items ?? []).map((item) => item.alId));
  const sheetIds = new Set((sheet?.items ?? []).map((item) => item.alId));
  if (catalogIds.size !== sheetIds.size) {
    fail(`catalog.json has ${catalogIds.size} IDs while sheet.json has ${sheetIds.size}.`);
  }
  for (const id of catalogIds) {
    if (!sheetIds.has(id)) fail(`sheet.json is missing catalog AniList ID ${id}.`);
  }
  for (const id of sheetIds) {
    if (!catalogIds.has(id)) fail(`sheet.json contains unknown AniList ID ${id}.`);
  }
}

async function validateEntries(status, catalog, sheet) {
  await assertDirectory(entriesDir, "entries directory");
  let entryFiles = [];
  try {
    entryFiles = (await readdir(entriesDir)).filter((file) => /^\d+\.json$/u.test(file)).sort(numericFileSort);
  } catch (error) {
    fail(`Unable to read entries directory: ${formatError(error)}`);
    return;
  }

  const expectedCount = status?.counts?.entries;
  if (Number.isInteger(expectedCount) && entryFiles.length !== expectedCount) {
    fail(`entries directory has ${entryFiles.length} files; status.json reports ${expectedCount}.`);
  }
  if (Array.isArray(catalog?.items) && entryFiles.length !== catalog.items.length) {
    fail(`entries directory has ${entryFiles.length} files; catalog has ${catalog.items.length} items.`);
  }

  const catalogById = new Map((catalog?.items ?? []).map((item) => [item.alId, item]));
  const sheetIds = new Set((sheet?.items ?? []).map((item) => item.alId));
  const seenTorrentIds = new Map();
  let torrentCount = 0;
  let bestTorrentCount = 0;
  let entriesWithoutTorrents = 0;

  for (const file of entryFiles) {
    const value = await readJson(join(entriesDir, file));
    if (!isRecord(value) || !isRecord(value.entry) || !Array.isArray(value.torrents)) {
      fail(`${file} must contain entry and torrents.`);
      continue;
    }
    const alId = value.entry.alId;
    const expectedId = Number(file.slice(0, -5));
    if (alId !== expectedId) fail(`${file} contains entry.alId ${alId}; expected ${expectedId}.`);
    if (!isNonEmptyString(value.entry?.titles?.display)) fail(`${file} is missing entry.titles.display.`);
    if (!catalogById.has(alId)) fail(`${file} has no matching catalog item.`);
    if (!sheetIds.has(alId)) fail(`${file} has no matching sheet item.`);

    const best = value.torrents.filter((torrent) => torrent?.isBest === true).length;
    if (value.entry.torrentCount !== value.torrents.length) {
      fail(`${file} torrentCount ${value.entry.torrentCount} != ${value.torrents.length} torrent rows.`);
    }
    if (value.entry.bestTorrentCount !== best) {
      fail(`${file} bestTorrentCount ${value.entry.bestTorrentCount} != ${best}.`);
    }
    const catalogItem = catalogById.get(alId);
    if (catalogItem?.torrentCount !== value.torrents.length || catalogItem?.bestTorrentCount !== best) {
      fail(`${file} torrent counts do not match catalog.json.`);
    }

    if (value.torrents.length === 0) entriesWithoutTorrents += 1;
    torrentCount += value.torrents.length;
    bestTorrentCount += best;
    for (const torrent of value.torrents) {
      if (!isNonEmptyString(torrent?.id)) {
        fail(`${file} contains a torrent without an ID.`);
        continue;
      }
      const previous = seenTorrentIds.get(torrent.id);
      if (previous !== undefined) {
        fail(`Torrent ${torrent.id} is duplicated${previous === alId ? ` within entry ${alId}` : ` across entries ${previous} and ${alId}`}.`);
      }
      seenTorrentIds.set(torrent.id, alId);
    }
  }

  if (torrentCount !== status?.counts?.torrents) {
    fail(`Verified ${torrentCount} torrents; status.json reports ${status?.counts?.torrents}.`);
  }
  if (torrentCount !== status?.integrity?.sourceTorrentCount) {
    fail(`Verified ${torrentCount} torrents; integrity.sourceTorrentCount reports ${status?.integrity?.sourceTorrentCount}.`);
  }
  if (entriesWithoutTorrents !== status?.integrity?.entriesWithoutTorrents) {
    fail(`Verified ${entriesWithoutTorrents} entries without torrents; status reports ${status?.integrity?.entriesWithoutTorrents}.`);
  }
  if (bestTorrentCount > torrentCount) fail("Best torrent count cannot exceed total torrent count.");
}

async function assertDirectory(path, label) {
  try {
    const result = await stat(path);
    if (!result.isDirectory()) fail(`${label} exists but is not a directory: ${path}`);
  } catch {
    fail(`Missing ${label}: ${path}. Run npm run data:build first.`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Missing or invalid JSON: ${path}. ${formatError(error)}`);
    return null;
  }
}

function assertUniqueNumericIds(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const id = item?.[key];
    if (!isPositiveInteger(id)) {
      fail(`${label} contains an invalid ${key}.`);
      continue;
    }
    if (seen.has(id)) fail(`${label} contains duplicate ${key} ${id}.`);
    seen.add(id);
  }
}

function numericFileSort(left, right) {
  return Number(left.slice(0, -5)) - Number(right.slice(0, -5));
}
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPositiveInteger(value) { return Number.isInteger(value) && value > 0; }
function isNonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }
function isNonEmptyString(value) { return typeof value === "string" && value.trim().length > 0; }
function formatError(error) { return error instanceof Error ? error.message : String(error); }
function fail(message) { failures.push(message); }

main().catch((error) => {
  console.error(`Mirror data verification crashed: ${formatError(error)}`);
  process.exitCode = 1;
});
