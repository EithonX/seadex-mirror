import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  listFiles,
  sha256File,
  sha256Json,
  sha256Buffer,
  stableStringify,
  validateSnapshotManifest,
} from "./snapshot-integrity.mjs";

export const SITE_BUILD_SCHEMA_VERSION = 1;
export const SITE_BUILD_FILE = "site-build.json";
const MIRROR_DATA_PREFIX = "mirror-data/";
const MIRROR_MANIFEST_PATH = `${MIRROR_DATA_PREFIX}manifest.json`;

export async function createSiteBuildDescriptor(distDir) {
  const root = resolve(distDir);
  const manifestPath = resolve(root, MIRROR_MANIFEST_PATH);
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseJson(manifestBytes.toString("utf8"), MIRROR_MANIFEST_PATH);
  validateSnapshotManifest(manifest);

  const paths = (await listFiles(root))
    .filter((path) => path !== SITE_BUILD_FILE && !path.startsWith(MIRROR_DATA_PREFIX))
    .sort((left, right) => left.localeCompare(right));

  if (!paths.includes("index.html")) {
    throw new Error("Site build is missing dist/index.html.");
  }

  const files = [];
  let totalBytes = 0;
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const fileStat = await stat(absolutePath);
    const sha256 = await sha256File(absolutePath);
    totalBytes += fileStat.size;
    files.push({ path, bytes: fileStat.size, sha256 });
  }

  const identity = {
    schemaVersion: SITE_BUILD_SCHEMA_VERSION,
    algorithm: "sha256",
    snapshotId: manifest.snapshotId,
    mirrorManifestSha256: sha256Buffer(manifestBytes),
    totals: {
      files: files.length,
      bytes: totalBytes,
    },
    files,
  };

  return {
    ...identity,
    fingerprint: sha256Json(identity),
  };
}

export async function writeSiteBuildDescriptor(distDir) {
  const root = resolve(distDir);
  const descriptor = await createSiteBuildDescriptor(root);
  await writeFile(resolve(root, SITE_BUILD_FILE), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  return descriptor;
}

export async function readSiteBuildDescriptor(path) {
  const payload = parseJson(await readFile(path, "utf8"), SITE_BUILD_FILE);
  return validateSiteBuildDescriptor(payload);
}

export function validateSiteBuildDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Site build descriptor must be a JSON object.");
  }
  if (value.schemaVersion !== SITE_BUILD_SCHEMA_VERSION) {
    throw new Error(`Unsupported site build schema version: ${value.schemaVersion}.`);
  }
  if (value.algorithm !== "sha256") {
    throw new Error(`Unsupported site build digest algorithm: ${value.algorithm}.`);
  }
  validateSha256(value.snapshotId, "site build snapshotId");
  validateSha256(value.mirrorManifestSha256, "site build mirrorManifestSha256");
  validateSha256(value.fingerprint, "site build fingerprint");

  if (!value.totals || typeof value.totals !== "object" || Array.isArray(value.totals)) {
    throw new Error("Site build descriptor is missing totals.");
  }
  if (!Number.isSafeInteger(value.totals.files) || value.totals.files <= 0) {
    throw new Error("Site build descriptor has an invalid totals.files value.");
  }
  if (!Number.isSafeInteger(value.totals.bytes) || value.totals.bytes < 0) {
    throw new Error("Site build descriptor has an invalid totals.bytes value.");
  }
  if (!Array.isArray(value.files) || value.files.length !== value.totals.files) {
    throw new Error("Site build descriptor file count does not match totals.files.");
  }

  const seen = new Set();
  let totalBytes = 0;
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error("Site build descriptor contains an invalid file record.");
    }
    validateSitePath(file.path);
    if (file.path === SITE_BUILD_FILE || file.path.startsWith(MIRROR_DATA_PREFIX)) {
      throw new Error(`Site build descriptor contains reserved path: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Site build descriptor contains duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Site build descriptor has an invalid byte size for ${file.path}.`);
    }
    validateSha256(file.sha256, `site build SHA-256 for ${file.path}`);
    totalBytes += file.bytes;
  }

  if (!seen.has("index.html")) {
    throw new Error("Site build descriptor does not contain index.html.");
  }
  if (totalBytes !== value.totals.bytes) {
    throw new Error(`Site build descriptor totals.bytes is ${value.totals.bytes}, expected ${totalBytes}.`);
  }

  const identity = descriptorIdentity(value);
  if (sha256Json(identity) !== value.fingerprint) {
    throw new Error("Site build descriptor fingerprint does not match its contents.");
  }

  return value;
}

export function siteBuildDescriptorsMatch(left, right) {
  try {
    const normalizedLeft = validateSiteBuildDescriptor(left);
    const normalizedRight = validateSiteBuildDescriptor(right);
    return normalizedLeft.fingerprint === normalizedRight.fingerprint;
  } catch {
    return false;
  }
}

export function descriptorIdentity(value) {
  return {
    schemaVersion: value.schemaVersion,
    algorithm: value.algorithm,
    snapshotId: value.snapshotId,
    mirrorManifestSha256: value.mirrorManifestSha256,
    totals: value.totals,
    files: value.files,
  };
}

export function stableSiteBuildJson(value) {
  return stableStringify(validateSiteBuildDescriptor(value));
}

function validateSitePath(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Site build descriptor contains an empty path.");
  }
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Site build descriptor contains an unsafe path: ${path}`);
  }
}

function validateSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(String(value ?? ""))) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
