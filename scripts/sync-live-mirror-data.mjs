// Downloads the currently deployed mirror-data snapshot into
// frontend/public/mirror-data so the site can be redeployed (e.g. for a
// header-only change) while the upstream source is down, without regressing data.
// Files are staged in a temp directory and swapped in only after every
// download succeeds, so a failed sync never leaves a partial snapshot behind.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const BASE_URL = (process.env.MIRROR_BASE_URL ?? "https://seadex.pages.dev").replace(/\/+$/, "");
const OUTPUT_DIR = resolve("frontend/public/mirror-data");
const STAGING_DIR = resolve("tmp/mirror-data-sync-staging");
const CONCURRENCY = 12;
const RETRY_LIMIT = 3;

async function fetchText(path) {
  const url = `${BASE_URL}/mirror-data/${path}`;
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === RETRY_LIMIT) throw new Error(`Failed to fetch ${url}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function save(path, text) {
  const target = join(STAGING_DIR, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function main() {
  console.log(`Syncing live mirror data from ${BASE_URL} into ${OUTPUT_DIR}`);
  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });

  const statusText = await fetchText("status.json");
  const status = JSON.parse(statusText);
  const catalogText = await fetchText("catalog.json");
  const catalog = JSON.parse(catalogText);
  if (!Array.isArray(catalog.items) || catalog.items.length === 0) {
    throw new Error("Live catalog.json has no items; refusing to sync.");
  }
  if (catalog.items.length !== status?.counts?.entries) {
    throw new Error(
      `Live snapshot is inconsistent: catalog has ${catalog.items.length} items but status.json reports ${status?.counts?.entries}. A deploy may be in progress; retry later.`,
    );
  }
  await save("status.json", statusText);
  await save("catalog.json", catalogText);
  for (const name of ["sheet.json", "sheet-workbook.json", "anilist-cache.json"]) {
    await save(name, await fetchText(name));
    console.log(`Saved ${name}`);
  }

  const ids = catalog.items.map((item) => item.alId);
  const queue = [...ids];
  let done = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        try {
          await save(`entries/${id}.json`, await fetchText(`entries/${id}.json`));
        } catch (error) {
          failures.push(id);
          console.error(error.message);
        }
        done++;
        if (done % 250 === 0) console.log(`Entries: ${done}/${ids.length}`);
      }
    }),
  );
  console.log(`Entries: ${done}/${ids.length}, failures: ${failures.length}`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} entry file(s) failed to download; leaving ${OUTPUT_DIR} untouched.`);
  }

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await rename(STAGING_DIR, OUTPUT_DIR);
  console.log("Sync complete.");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => rm(STAGING_DIR, { recursive: true, force: true }));
