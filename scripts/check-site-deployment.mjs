import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithRetry, readJsonResponse, readResponseBuffer } from "./lib/http.mjs";
import {
  SITE_BUILD_FILE,
  createSiteBuildDescriptor,
  readSiteBuildDescriptor,
  stableSiteBuildJson,
  validateSiteBuildDescriptor,
} from "./lib/site-build.mjs";
import { sha256Buffer } from "./lib/snapshot-integrity.mjs";

const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = resolve(args.dist ?? process.env.PAGES_DIST_DIR ?? "dist");
  const descriptorPath = resolve(distDir, SITE_BUILD_FILE);
  const [storedLocal, recomputedLocal] = await Promise.all([
    readSiteBuildDescriptor(descriptorPath),
    createSiteBuildDescriptor(distDir),
  ]);
  if (stableSiteBuildJson(storedLocal) !== stableSiteBuildJson(recomputedLocal)) {
    throw new Error("dist/site-build.json does not match the current deployable site contents.");
  }
  const local = storedLocal;
  const baseUrl = normalizeBaseUrl(
    args.baseUrl ?? process.env.SITE_BASE_URL ?? defaultPagesBaseUrl(process.env.CLOUDFLARE_PAGES_PROJECT_NAME),
  );

  const report = await checkDeployment({
    baseUrl,
    local,
    timeoutMs: positiveInt(process.env.SITE_COMPARE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    retries: nonNegativeInt(process.env.SITE_COMPARE_RETRIES, DEFAULT_RETRIES),
  });

  if (args.report) {
    await writeFile(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (report.deploy) {
    console.log(`Site deployment required: ${report.reason}.`);
  } else {
    console.log(
      `Site output is unchanged (${local.fingerprint.slice(0, 12)}); Cloudflare deployment can be skipped.`,
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

export async function checkDeployment({
  baseUrl,
  local,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  fetchImpl = globalThis.fetch,
}) {
  validateSiteBuildDescriptor(local);

  let remote;
  try {
    const response = await fetchWithRetry(
      `${baseUrl}/${SITE_BUILD_FILE}`,
      { headers: { "cache-control": "no-cache" } },
      {
        timeoutMs,
        retries,
        label: "production site-build.json",
        fetchImpl,
      },
    );
    remote = validateSiteBuildDescriptor(
      await readJsonResponse(response, {
        maxBytes: MAX_DESCRIPTOR_BYTES,
        label: "production site-build.json",
      }),
    );
  } catch (error) {
    return deploymentRequired("production-site-build-unavailable", local, null, error);
  }

  if (remote.fingerprint !== local.fingerprint) {
    return deploymentRequired("site-fingerprint-changed", local, remote);
  }

  let manifestSha256;
  try {
    const response = await fetchWithRetry(
      `${baseUrl}/mirror-data/manifest.json`,
      { headers: { "cache-control": "no-cache" } },
      {
        timeoutMs,
        retries,
        label: "production mirror manifest",
        fetchImpl,
      },
    );
    const bytes = await readResponseBuffer(response, {
      maxBytes: MAX_MANIFEST_BYTES,
      label: "production mirror manifest",
    });
    manifestSha256 = sha256Buffer(bytes);
  } catch (error) {
    return deploymentRequired("production-manifest-unavailable", local, remote, error);
  }

  if (manifestSha256 !== local.mirrorManifestSha256 || manifestSha256 !== remote.mirrorManifestSha256) {
    return deploymentRequired("production-manifest-mismatch", local, remote);
  }

  if (remote.snapshotId !== local.snapshotId) {
    return deploymentRequired("production-snapshot-mismatch", local, remote);
  }

  return {
    deploy: false,
    reason: "site-output-unchanged",
    localFingerprint: local.fingerprint,
    remoteFingerprint: remote.fingerprint,
    snapshotId: local.snapshotId,
    mirrorManifestSha256: local.mirrorManifestSha256,
  };
}

function deploymentRequired(reason, local, remote = null, error = null) {
  return {
    deploy: true,
    reason,
    localFingerprint: local.fingerprint,
    remoteFingerprint: remote?.fingerprint ?? null,
    snapshotId: local.snapshotId,
    mirrorManifestSha256: local.mirrorManifestSha256,
    ...(error ? { detail: error instanceof Error ? error.message : String(error) } : {}),
  };
}

function parseArgs(argv) {
  const result = { baseUrl: null, dist: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--base-url=")) {
      result.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg.startsWith("--dist=")) {
      result.dist = arg.slice("--dist=".length);
      continue;
    }
    if (arg.startsWith("--report=")) {
      result.report = arg.slice("--report=".length);
      continue;
    }
    if (arg === "--base-url" || arg === "--dist" || arg === "--report") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      result[arg.slice(2).replace("-url", "Url")] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function normalizeBaseUrl(value) {
  if (!value) {
    throw new Error("A production site base URL is required.");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported production site protocol: ${url.protocol}`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function defaultPagesBaseUrl(projectName) {
  const project = String(projectName ?? "").trim();
  return project ? `https://${project}.pages.dev` : "";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Site deployment check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
