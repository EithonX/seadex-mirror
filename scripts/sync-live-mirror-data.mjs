// Restores the exact deployed mirror-data snapshot into frontend/public/mirror-data.
// The remote manifest is downloaded first, every listed file is hash-verified in
// staging, and the previous local snapshot is replaced atomically only after the
// complete snapshot passes verification.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { replaceDirectoryAtomically } from "./lib/atomic-directory.mjs";
import { fetchWithRetry, readResponseBuffer, readJsonResponse } from "./lib/http.mjs";
import { validateSnapshotManifest, verifySnapshotManifest } from "./lib/snapshot-integrity.mjs";

const BASE_URL = (process.env.MIRROR_BASE_URL ?? "https://seadex.pages.dev").replace(/\/+$/u, "");
const OUTPUT_DIR = resolve("frontend/public/mirror-data");
const OUTPUT_PARENT = dirname(OUTPUT_DIR);
const STAGING_DIR = join(
  OUTPUT_PARENT,
  `.${basename(OUTPUT_DIR)}.sync-${process.pid}-${Date.now()}`,
);
const CONCURRENCY = positiveInt(process.env.MIRROR_SYNC_CONCURRENCY, 12);
const RETRY_LIMIT = positiveInt(process.env.MIRROR_SYNC_RETRIES, 4);
const MAX_REMOTE_FILE_BYTES = 64 * 1024 * 1024;

async function main() {
  console.log(`Syncing verified live mirror data from ${BASE_URL} into ${OUTPUT_DIR}`);
  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });

  const manifestResponse = await fetchWithRetry(
    `${BASE_URL}/mirror-data/manifest.json`,
    { headers: { accept: "application/json" } },
    { retries: RETRY_LIMIT, label: "Live snapshot manifest" },
  );
  const manifest = await readJsonResponse(manifestResponse, {
    maxBytes: 4 * 1024 * 1024,
    label: "Live snapshot manifest",
  });
  validateManifestForDownload(manifest);

  const queue = [...manifest.files];
  let completed = 0;
  const failures = [];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) break;
        try {
          const response = await fetchWithRetry(
            `${BASE_URL}/mirror-data/${file.path.split("/").map(encodeURIComponent).join("/")}`,
            {},
            { retries: RETRY_LIMIT, label: `Live snapshot ${file.path}` },
          );
          const bytes = await readResponseBuffer(response, {
            maxBytes: Math.min(MAX_REMOTE_FILE_BYTES, file.bytes + 1),
            label: `Live snapshot ${file.path}`,
          });
          if (bytes.length !== file.bytes) {
            throw new Error(`Expected ${file.bytes} bytes, received ${bytes.length}.`);
          }
          const target = join(STAGING_DIR, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
        } catch (error) {
          failures.push(`${file.path}: ${formatError(error)}`);
        } finally {
          completed += 1;
          if (completed % 250 === 0 || completed === manifest.files.length) {
            console.log(`Files: ${completed}/${manifest.files.length}`);
          }
        }
      }
    }),
  );

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} snapshot file(s) failed to download; previous local snapshot retained. First failure: ${failures[0]}`,
    );
  }

  await writeFile(join(STAGING_DIR, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  const verified = await verifySnapshotManifest(STAGING_DIR, manifest);
  await replaceDirectoryAtomically(STAGING_DIR, OUTPUT_DIR);
  console.log(
    `Sync complete: snapshot ${verified.snapshotId.slice(0, 12)}, ${verified.files} verified files.`,
  );
}

function validateManifestForDownload(manifest) {
  validateSnapshotManifest(manifest);
  for (const file of manifest.files) {
    if (file.bytes > MAX_REMOTE_FILE_BYTES) {
      throw new Error(
        `Live manifest file ${file.path} is ${file.bytes} bytes, above the ${MAX_REMOTE_FILE_BYTES}-byte sync safety limit.`,
      );
    }
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function formatError(error) { return error instanceof Error ? error.message : String(error); }

main()
  .catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  })
  .finally(() => rm(STAGING_DIR, { recursive: true, force: true }));
