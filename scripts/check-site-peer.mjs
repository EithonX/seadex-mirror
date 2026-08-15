import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchWithRetry, readJsonResponse, readResponseBuffer } from "./lib/http.mjs";
import { sha256Buffer } from "./lib/snapshot-integrity.mjs";
import { validateSiteBuildDescriptor } from "./lib/site-build.mjs";

const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const primaryBaseUrl = normalizeBaseUrl(args.primary ?? process.env.PRIMARY_SITE_BASE_URL);
  const secondaryBaseUrl = normalizeBaseUrl(args.secondary ?? process.env.SECONDARY_SITE_BASE_URL);

  const primary = await fetchSiteIdentity(primaryBaseUrl, { required: true });
  const secondary = await fetchSiteIdentity(secondaryBaseUrl, { required: false });
  const report = compareSiteIdentities(primary, secondary);

  if (args.report) {
    await writeFile(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (report.repair) {
    console.log(`Secondary site repair required: ${report.reason}.`);
  } else {
    console.log(`Secondary site matches primary (${primary.descriptor.fingerprint.slice(0, 12)}).`);
  }
  console.log(JSON.stringify(report, null, 2));
}

export async function fetchSiteIdentity(baseUrl, {
  required = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const descriptorResponse = await fetchWithRetry(
      `${baseUrl}/site-build.json`,
      { headers: { "cache-control": "no-cache" } },
      { timeoutMs, retries, label: `${baseUrl} site-build.json`, fetchImpl },
    );
    const descriptor = validateSiteBuildDescriptor(await readJsonResponse(descriptorResponse, {
      maxBytes: MAX_DESCRIPTOR_BYTES,
      label: `${baseUrl} site-build.json`,
    }));

    const manifestResponse = await fetchWithRetry(
      `${baseUrl}/mirror-data/manifest.json`,
      { headers: { "cache-control": "no-cache" } },
      { timeoutMs, retries, label: `${baseUrl} mirror manifest`, fetchImpl },
    );
    const manifestBytes = await readResponseBuffer(manifestResponse, {
      maxBytes: MAX_MANIFEST_BYTES,
      label: `${baseUrl} mirror manifest`,
    });
    const manifestSha256 = sha256Buffer(manifestBytes);
    if (descriptor.mirrorManifestSha256 !== manifestSha256) {
      throw new Error("site-build.json mirror manifest digest differs from the served manifest");
    }

    return { baseUrl, descriptor, manifestSha256, error: null };
  } catch (error) {
    if (required) {
      throw new Error(`Primary site identity is unavailable at ${baseUrl}: ${message(error)}`, { cause: error });
    }
    return { baseUrl, descriptor: null, manifestSha256: null, error: message(error) };
  }
}

export function compareSiteIdentities(primary, secondary) {
  if (!primary?.descriptor || !primary.manifestSha256) {
    throw new Error("A verified primary site identity is required.");
  }
  if (!secondary?.descriptor || !secondary.manifestSha256) {
    return report(true, "secondary-site-unavailable", primary, secondary);
  }
  if (secondary.descriptor.fingerprint !== primary.descriptor.fingerprint) {
    return report(true, "site-fingerprint-mismatch", primary, secondary);
  }
  if (secondary.descriptor.snapshotId !== primary.descriptor.snapshotId) {
    return report(true, "snapshot-mismatch", primary, secondary);
  }
  if (secondary.manifestSha256 !== primary.manifestSha256) {
    return report(true, "mirror-manifest-mismatch", primary, secondary);
  }
  return report(false, "sites-in-sync", primary, secondary);
}

function report(repair, reason, primary, secondary) {
  return {
    repair,
    reason,
    primaryBaseUrl: primary.baseUrl,
    secondaryBaseUrl: secondary?.baseUrl ?? null,
    primaryFingerprint: primary.descriptor.fingerprint,
    secondaryFingerprint: secondary?.descriptor?.fingerprint ?? null,
    snapshotId: primary.descriptor.snapshotId,
    mirrorManifestSha256: primary.manifestSha256,
    ...(secondary?.error ? { detail: secondary.error } : {}),
  };
}

function parseArgs(argv) {
  const result = { primary: null, secondary: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const keyed = ["primary", "secondary", "report"].find((key) => arg.startsWith(`--${key}=`));
    if (keyed) {
      result[keyed] = arg.slice(keyed.length + 3);
      continue;
    }
    if (arg === "--primary" || arg === "--secondary" || arg === "--report") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${arg} requires a value.`);
      result[arg.slice(2)] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function normalizeBaseUrl(value) {
  if (!value) throw new Error("Both primary and secondary site URLs are required.");
  const url = new URL(String(value));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported site protocol: ${url.protocol}`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

function message(error) { return error instanceof Error ? error.message : String(error); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Site peer check failed: ${message(error)}`);
    process.exitCode = 1;
  });
}
