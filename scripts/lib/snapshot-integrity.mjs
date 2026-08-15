import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 3;
export const SOURCE_REVISION_SCHEMA_VERSION = 1;
export const SNAPSHOT_MANIFEST_FILE = "manifest.json";

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), "utf8"));
}

export function stableStringify(value) {
  return JSON.stringify(sortForStableJson(value));
}

export function sha256Json(value) {
  return sha256Text(stableStringify(value));
}

export function buildSeaDexFingerprint(listIds, entries) {
  const normalizedIds = [...new Set(listIds.map(Number).filter(Number.isInteger))].sort((left, right) => left - right);
  const normalizedEntries = entries
    .map(normalizeSeaDexEntry)
    .sort((left, right) => Number(left?.alID ?? 0) - Number(right?.alID ?? 0));

  return sha256Json({ listIds: normalizedIds, entries: normalizedEntries });
}

export function buildWorkbookContentFingerprint(sheetWorkbook) {
  return sha256Json(normalizeWorkbookContent(sheetWorkbook));
}

export function buildSourceFingerprint({ sourceBaseUrl, seaDexFingerprint, workbookContentSha256 }) {
  const normalizedSourceBaseUrl = normalizeSourceBaseUrl(sourceBaseUrl);
  return sha256Json({
    sourceBaseUrl: normalizedSourceBaseUrl,
    seaDexFingerprint,
    workbookContentSha256,
  });
}

export function buildSourceRevision({ sourceBaseUrl, seaDexGuard, workbookContentSha256 }) {
  const normalizedSourceBaseUrl = normalizeSourceBaseUrl(sourceBaseUrl);
  validateSha256(seaDexGuard?.fingerprint, "SeaDex guard fingerprint");
  validateSha256(workbookContentSha256, "workbook content fingerprint");

  const listIds = Array.isArray(seaDexGuard?.listIds) ? seaDexGuard.listIds : [];
  if (listIds.length === 0 || listIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("SeaDex guard must contain a non-empty list of positive integer AniList IDs.");
  }
  if (new Set(listIds).size !== listIds.length) {
    throw new Error("SeaDex guard contains duplicate AniList IDs.");
  }

  const entries = normalizeCollectionRevision(seaDexGuard?.entries, "entries");
  const torrents = normalizeCollectionRevision(seaDexGuard?.torrents, "torrents");
  if (entries.count !== listIds.length) {
    throw new Error(
      `SeaDex guard is internally inconsistent: ${listIds.length} listIDs vs ${entries.count} entry records.`,
    );
  }

  return {
    schemaVersion: SOURCE_REVISION_SCHEMA_VERSION,
    sourceBaseUrl: normalizedSourceBaseUrl,
    seaDex: {
      fingerprint: seaDexGuard.fingerprint,
      listIdsSha256: sha256Json([...listIds].sort((left, right) => left - right)),
      listIdCount: listIds.length,
      entries,
      torrents,
    },
    workbookContentSha256,
  };
}

export function validateSourceRevision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Snapshot source revision must be an object.");
  }
  if (value.schemaVersion !== SOURCE_REVISION_SCHEMA_VERSION) {
    throw new Error(`Unsupported source revision schema version: ${value.schemaVersion}.`);
  }

  const sourceBaseUrl = normalizeSourceBaseUrl(value.sourceBaseUrl);
  const seaDex = value.seaDex;
  if (!seaDex || typeof seaDex !== "object" || Array.isArray(seaDex)) {
    throw new Error("Snapshot source revision is missing SeaDex guard metadata.");
  }
  validateSha256(seaDex.fingerprint, "stored SeaDex guard fingerprint");
  validateSha256(seaDex.listIdsSha256, "stored SeaDex listIDs fingerprint");
  if (!Number.isSafeInteger(seaDex.listIdCount) || seaDex.listIdCount <= 0) {
    throw new Error("Snapshot source revision has an invalid SeaDex listIdCount.");
  }
  const entries = normalizeCollectionRevision(seaDex.entries, "stored entries");
  const torrents = normalizeCollectionRevision(seaDex.torrents, "stored torrents");
  if (entries.count !== seaDex.listIdCount) {
    throw new Error(
      `Snapshot source revision is internally inconsistent: ${seaDex.listIdCount} listIDs vs ${entries.count} entry records.`,
    );
  }
  validateSha256(value.workbookContentSha256, "stored workbook content fingerprint");

  return {
    schemaVersion: SOURCE_REVISION_SCHEMA_VERSION,
    sourceBaseUrl,
    seaDex: {
      fingerprint: seaDex.fingerprint,
      listIdsSha256: seaDex.listIdsSha256,
      listIdCount: seaDex.listIdCount,
      entries,
      torrents,
    },
    workbookContentSha256: value.workbookContentSha256,
  };
}

export function sourceRevisionMatches(left, right) {
  try {
    return stableStringify(validateSourceRevision(left)) === stableStringify(validateSourceRevision(right));
  } catch {
    return false;
  }
}

export function buildSnapshotId({ sourceFingerprint, aniListMedia, sheetWorkbook = null }) {
  const media = [...aniListMedia.entries()]
    .map(([id, value]) => [Number(id), value])
    .sort((left, right) => left[0] - right[0]);
  const workbookContent = normalizeWorkbookContent(sheetWorkbook);
  return sha256Json({ sourceFingerprint, aniListMedia: media, sheetWorkbook: workbookContent });
}

function normalizeWorkbookContent(sheetWorkbook) {
  if (!sheetWorkbook) {
    return null;
  }
  return Object.fromEntries(Object.entries(sheetWorkbook).filter(([key]) => key !== "generatedAt"));
}

export async function createSnapshotManifest(rootDir, metadata) {
  const root = resolve(rootDir);
  const paths = (await listFiles(root))
    .filter((path) => path !== SNAPSHOT_MANIFEST_FILE)
    .sort((left, right) => left.localeCompare(right));
  const files = [];
  let totalBytes = 0;

  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const fileStat = await stat(absolutePath);
    const sha256 = await sha256File(absolutePath);
    totalBytes += fileStat.size;
    files.push({ path, bytes: fileStat.size, sha256 });
  }

  return {
    schemaVersion: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    algorithm: "sha256",
    snapshotId: metadata.snapshotId,
    sourceFingerprint: metadata.sourceFingerprint,
    generatedAt: metadata.generatedAt,
    totals: {
      files: files.length,
      bytes: totalBytes,
    },
    files,
  };
}

export function validateSnapshotManifest(manifest) {
  validateManifestShape(manifest);

  const seen = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    validateRelativeManifestPath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`Snapshot manifest contains duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    totalBytes += file.bytes;
  }

  if (manifest.totals.files !== manifest.files.length) {
    throw new Error(`Snapshot manifest totals.files is ${manifest.totals.files}, expected ${manifest.files.length}.`);
  }
  if (manifest.totals.bytes !== totalBytes) {
    throw new Error(`Snapshot manifest totals.bytes is ${manifest.totals.bytes}, expected ${totalBytes}.`);
  }

  return manifest;
}

export async function verifySnapshotManifest(rootDir, manifest, options = {}) {
  const root = resolve(rootDir);
  validateSnapshotManifest(manifest);

  const expectedPaths = new Set();
  let verifiedBytes = 0;

  for (const file of manifest.files) {
    expectedPaths.add(file.path);

    const absolutePath = resolve(root, file.path);
    ensureWithinRoot(root, absolutePath);
    await access(absolutePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error(`Snapshot manifest path is not a regular file: ${file.path}`);
    }
    if (fileStat.size !== file.bytes) {
      throw new Error(`Snapshot size mismatch for ${file.path}: ${fileStat.size} != ${file.bytes}.`);
    }

    const digest = await sha256File(absolutePath);
    if (digest !== file.sha256) {
      throw new Error(`Snapshot SHA-256 mismatch for ${file.path}.`);
    }
    verifiedBytes += fileStat.size;
  }

  if (options.allowExtraFiles !== true) {
    const actualPaths = (await listFiles(root)).filter((path) => path !== SNAPSHOT_MANIFEST_FILE);
    for (const path of actualPaths) {
      if (!expectedPaths.has(path)) {
        throw new Error(`Snapshot contains unmanifested file: ${path}`);
      }
    }
    if (actualPaths.length !== expectedPaths.size) {
      throw new Error(`Snapshot file-count mismatch: found ${actualPaths.length}, manifest has ${expectedPaths.size}.`);
    }
  }

  if (manifest.totals.bytes !== verifiedBytes) {
    throw new Error(`Snapshot manifest totals.bytes is ${manifest.totals.bytes}, verified ${verifiedBytes}.`);
  }

  return {
    snapshotId: manifest.snapshotId,
    sourceFingerprint: manifest.sourceFingerprint,
    files: manifest.files.length,
    bytes: verifiedBytes,
  };
}

export async function readSnapshotManifest(rootDir) {
  return JSON.parse(await readFile(resolve(rootDir, SNAPSHOT_MANIFEST_FILE), "utf8"));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function listFiles(rootDir) {
  const root = resolve(rootDir);
  const results = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Snapshot contains unsupported filesystem entry: ${relative(root, absolutePath)}`);
      }
      results.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }

  await walk(root);
  return results;
}

function normalizeSeaDexEntry(entry) {
  const normalized = cloneJson(entry);
  if (Array.isArray(normalized?.trs)) {
    normalized.trs.sort(compareUnknownIds);
  }
  if (Array.isArray(normalized?.expand?.trs)) {
    normalized.expand.trs.sort((left, right) => compareUnknownIds(left?.id, right?.id));
  }
  return normalized;
}

function compareUnknownIds(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortForStableJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!value || typeof value !== "object" || value instanceof Date) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortForStableJson(value[key])]),
  );
}

function normalizeSourceBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch (error) {
    throw new Error("Source revision contains an invalid sourceBaseUrl.", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Source revision uses an unsupported protocol: ${url.protocol}`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function normalizeCollectionRevision(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`SeaDex ${label} revision must be an object.`);
  }
  const count = Number(value.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`SeaDex ${label} revision has an invalid count.`);
  }

  if (count === 0) {
    if (value.latest !== null) {
      throw new Error(`SeaDex ${label} revision must have latest=null when count is 0.`);
    }
    return { count: 0, latest: null };
  }

  const latest = value.latest;
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) {
    throw new Error(`SeaDex ${label} revision is missing its latest record.`);
  }
  if (typeof latest.id !== "string" || latest.id.length === 0) {
    throw new Error(`SeaDex ${label} revision latest record has an invalid id.`);
  }
  if (typeof latest.updated !== "string" || !Number.isFinite(Date.parse(latest.updated))) {
    throw new Error(`SeaDex ${label} revision latest record has an invalid updated timestamp.`);
  }
  return { count, latest: { id: latest.id, updated: latest.updated } };
}

function validateSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(String(value ?? ""))) {
    throw new Error(`${label} must be a SHA-256 hex digest.`);
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Snapshot manifest is not an object.");
  }
  if (manifest.schemaVersion !== SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot manifest schema version: ${manifest.schemaVersion}.`);
  }
  if (manifest.algorithm !== "sha256") {
    throw new Error(`Unsupported snapshot manifest algorithm: ${manifest.algorithm}.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(manifest.snapshotId ?? ""))) {
    throw new Error("Snapshot manifest is missing a valid snapshotId.");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(manifest.sourceFingerprint ?? ""))) {
    throw new Error("Snapshot manifest is missing a valid sourceFingerprint.");
  }
  if (!Number.isFinite(Date.parse(String(manifest.generatedAt ?? "")))) {
    throw new Error("Snapshot manifest generatedAt must be a valid timestamp.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Snapshot manifest files must be a non-empty array.");
  }
  if (
    !manifest.totals ||
    !Number.isInteger(manifest.totals.files) ||
    manifest.totals.files < 0 ||
    !Number.isInteger(manifest.totals.bytes) ||
    manifest.totals.bytes < 0
  ) {
    throw new Error("Snapshot manifest totals are invalid.");
  }
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new Error("Snapshot manifest contains an invalid file record.");
    }
    if (!/^[a-f0-9]{64}$/u.test(String(file.sha256 ?? ""))) {
      throw new Error(`Snapshot manifest has an invalid SHA-256 for ${file.path ?? "unknown path"}.`);
    }
  }
}

function validateRelativeManifestPath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Unsafe snapshot manifest path: ${path}`);
  }
  if (path === SNAPSHOT_MANIFEST_FILE) {
    throw new Error("Snapshot manifest must not hash itself.");
  }
}

function ensureWithinRoot(root, target) {
  const prefix = `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`Snapshot manifest path escapes the snapshot root: ${target}`);
  }
}
