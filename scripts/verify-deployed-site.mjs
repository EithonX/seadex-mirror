import { readResponseBuffer } from "./lib/http.mjs";
import { sha256Buffer, validateSnapshotManifest } from "./lib/snapshot-integrity.mjs";

const MAX_ATTEMPTS = positiveInt(process.env.DEPLOY_VERIFY_ATTEMPTS, 6);
const RETRY_DELAY_MS = positiveInt(process.env.DEPLOY_VERIFY_DELAY_MS, 2_000);
const REQUEST_TIMEOUT_MS = positiveInt(process.env.DEPLOY_VERIFY_TIMEOUT_MS, 15_000);
const EXPECTED_SNAPSHOT_ID = (process.env.EXPECTED_SNAPSHOT_ID ?? "").trim();
const EXPECTED_MANIFEST_SHA256 = (process.env.EXPECTED_MANIFEST_SHA256 ?? "").trim();
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const REQUIRED_MANIFEST_PATHS = ["status.json", "catalog.json", "sheet.json", "sheet-workbook.json", "anilist-cache.json"];

async function main() {
  validateExpectedIdentity();
  const baseUrl = getBaseUrl();

  console.log("=== Deployed Site Verification ===");
  console.log(`INFO: Base URL: ${baseUrl}`);
  if (EXPECTED_SNAPSHOT_ID) {
    console.log(`INFO: Expected snapshot: ${EXPECTED_SNAPSHOT_ID.slice(0, 12)}`);
  }

  for (const path of ["/", "/about", "/sheet"]) {
    await retryCheck(path, async () => {
      const response = await fetchResponse(`${baseUrl}${path}`);
      assert(response.status === 200, `expected HTTP 200, got ${response.status}`);
      assert((response.headers.get("content-type") ?? "").includes("text/html"), "expected text/html");
      const text = (await readResponseBuffer(response, { maxBytes: MAX_HTML_BYTES, label: path })).toString("utf8");
      assert(text.includes("SeaDex") || text.includes('id="app"'), "app shell marker missing");
    });
    console.log(`OK: ${path} serves the app shell.`);
  }

  const manifestResult = await retryCheck("/mirror-data/manifest.json", async () => {
    const response = await fetchResponse(`${baseUrl}/mirror-data/manifest.json`);
    assert(response.status === 200, `expected HTTP 200, got ${response.status}`);
    const bytes = await readResponseBuffer(response, {
      maxBytes: MAX_MANIFEST_BYTES,
      label: "deployed manifest.json",
    });
    const manifest = parseJson(bytes.toString("utf8"), "manifest.json");
    validateManifest(manifest);

    const digest = sha256Buffer(bytes);
    if (EXPECTED_MANIFEST_SHA256) {
      assert(digest === EXPECTED_MANIFEST_SHA256, "remote manifest SHA-256 differs from the built artifact");
    }
    if (EXPECTED_SNAPSHOT_ID) {
      assert(
        manifest.snapshotId === EXPECTED_SNAPSHOT_ID,
        `manifest snapshot ${manifest.snapshotId} != expected ${EXPECTED_SNAPSHOT_ID}`,
      );
    }

    return {
      manifest,
      hasCacheControl: Boolean(response.headers.get("cache-control")),
    };
  });
  console.log(`OK: manifest.json identifies snapshot ${manifestResult.manifest.snapshotId.slice(0, 12)}.`);

  const manifestByPath = new Map(manifestResult.manifest.files.map((file) => [file.path, file]));
  const samplePaths = selectVerificationSample(manifestResult.manifest.files);
  let responsesWithCacheControl = manifestResult.hasCacheControl ? 1 : 0;
  let checkedCacheHeaders = 1;

  for (const path of samplePaths) {
    const expected = manifestByPath.get(path);
    assert(expected, `manifest sample path disappeared: ${path}`);

    const result = await retryCheck(`/mirror-data/${path}`, async () => {
      const response = await fetchResponse(`${baseUrl}/mirror-data/${encodePath(path)}`);
      assert(response.status === 200, `expected HTTP 200, got ${response.status}`);
      const bytes = await readResponseBuffer(response, {
        maxBytes: Math.min(MAX_JSON_BYTES, expected.bytes + 1),
        label: `deployed ${path}`,
      });
      assert(bytes.length === expected.bytes, `size ${bytes.length} != manifest ${expected.bytes}`);
      assert(sha256Buffer(bytes) === expected.sha256, "SHA-256 differs from manifest");
      return { hasCacheControl: Boolean(response.headers.get("cache-control")) };
    });

    checkedCacheHeaders += 1;
    if (result.hasCacheControl) responsesWithCacheControl += 1;
    console.log(`OK: ${path} matches the manifest.`);
  }

  const status = await fetchJsonWithRetry(`${baseUrl}/mirror-data/status.json`, "status.json", 2 * 1024 * 1024);
  if (EXPECTED_SNAPSHOT_ID) {
    assert(status?.snapshot?.id === EXPECTED_SNAPSHOT_ID, "status.json snapshot ID differs from expected snapshot");
  }
  assert(status?.snapshot?.id === manifestResult.manifest.snapshotId, "status.json snapshot ID differs from manifest");
  assert(
    status?.snapshot?.sourceFingerprint === manifestResult.manifest.sourceFingerprint,
    "status.json source fingerprint differs from manifest",
  );

  if (responsesWithCacheControl === 0 && checkedCacheHeaders > 0) {
    throw new Error("Cache-Control is missing from every checked mirror-data response.");
  }

  console.log(
    `OK: deployed snapshot ${manifestResult.manifest.snapshotId.slice(0, 12)} passed exact-manifest smoke verification.`,
  );
}

function getBaseUrl() {
  const explicit = (process.env.DEPLOYED_SITE_URL ?? "").trim();
  const candidate = explicit || `https://${(process.env.CLOUDFLARE_PAGES_PROJECT_NAME ?? "").trim() || "seadex"}.pages.dev`;
  let url;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new Error(`Invalid deployed site URL: ${message(error)}`, { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported deployed site protocol: ${url.protocol}`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

function selectVerificationSample(files) {
  const required = [...REQUIRED_MANIFEST_PATHS];
  const entryFiles = files
    .filter((file) => /^entries\/\d+\.json$/u.test(file.path))
    .sort((left, right) => Number(left.path.match(/\d+/u)?.[0]) - Number(right.path.match(/\d+/u)?.[0]));

  assert(entryFiles.length > 0, "manifest contains no entry JSON files");
  required.push(entryFiles[0].path, entryFiles[Math.floor(entryFiles.length / 2)].path, entryFiles.at(-1).path);
  return [...new Set(required)];
}

async function fetchJsonWithRetry(url, label, maxBytes) {
  return retryCheck(label, async () => {
    const response = await fetchResponse(url);
    assert(response.status === 200, `expected HTTP 200, got ${response.status}`);
    const bytes = await readResponseBuffer(response, { maxBytes, label });
    return parseJson(bytes.toString("utf8"), label);
  });
}

async function fetchResponse(url) {
  return fetch(url, {
    redirect: "follow",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function retryCheck(label, work) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`WARN: ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message(error)}. Retrying...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${message(lastError)}`);
}

function validateExpectedIdentity() {
  if (EXPECTED_SNAPSHOT_ID && !isSha256(EXPECTED_SNAPSHOT_ID)) {
    throw new Error("EXPECTED_SNAPSHOT_ID must be a lowercase SHA-256 hex digest.");
  }
  if (EXPECTED_MANIFEST_SHA256 && !isSha256(EXPECTED_MANIFEST_SHA256)) {
    throw new Error("EXPECTED_MANIFEST_SHA256 must be a lowercase SHA-256 hex digest.");
  }
}

function validateManifest(manifest) {
  try {
    validateSnapshotManifest(manifest);
  } catch (error) {
    throw new Error(`deployed manifest is invalid: ${message(error)}`, { cause: error });
  }

  const seen = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    assert(file.bytes <= MAX_JSON_BYTES, `manifest size exceeds verifier safety limit for ${file.path}`);
  }
  for (const path of REQUIRED_MANIFEST_PATHS) {
    assert(seen.has(path), `manifest is missing required file ${path}`);
  }
}

function encodePath(path) { return path.split("/").map(encodeURIComponent).join("/"); }
function parseJson(text, label) { try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); } }
function isSha256(value) { return /^[a-f0-9]{64}$/u.test(String(value ?? "")); }
function assert(condition, messageText) { if (!condition) throw new Error(messageText); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function message(error) { return error instanceof Error ? error.message : String(error); }

main().catch((error) => {
  console.error(`ERROR: ${message(error)}`);
  process.exitCode = 1;
});
