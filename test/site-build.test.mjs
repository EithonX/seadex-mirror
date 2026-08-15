import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SITE_BUILD_FILE,
  createSiteBuildDescriptor,
  readSiteBuildDescriptor,
  writeSiteBuildDescriptor,
} from "../scripts/lib/site-build.mjs";
import { createSnapshotManifest } from "../scripts/lib/snapshot-integrity.mjs";

const SNAPSHOT_ID = "a".repeat(64);
const SOURCE_FINGERPRINT = "b".repeat(64);

async function createDist() {
  const root = await mkdtemp(join(tmpdir(), "seadex-site-build-"));
  const mirrorDir = join(root, "mirror-data");
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(mirrorDir, { recursive: true });
  await writeFile(join(root, "index.html"), "<main>SeaDex</main>\n", "utf8");
  await writeFile(join(root, "assets/app.js"), "console.log('hello');\n", "utf8");
  await writeFile(join(root, "_headers"), "/*\n  Cache-Control: no-cache\n", "utf8");
  await writeFile(join(mirrorDir, "status.json"), '{"ok":true}\n', "utf8");
  await writeManifest(mirrorDir);
  return root;
}

async function writeManifest(mirrorDir) {
  const manifest = await createSnapshotManifest(mirrorDir, {
    snapshotId: SNAPSHOT_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    generatedAt: "2026-08-16T00:00:00.000Z",
  });
  await writeFile(join(mirrorDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("site build fingerprint is deterministic and excludes its own descriptor", async (t) => {
  const root = await createDist();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await writeSiteBuildDescriptor(root);
  const stored = await readSiteBuildDescriptor(join(root, SITE_BUILD_FILE));
  const second = await createSiteBuildDescriptor(root);

  assert.equal(stored.fingerprint, first.fingerprint);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(first.files.some((file) => file.path === SITE_BUILD_FILE), false);
  assert.equal(first.files.some((file) => file.path.startsWith("mirror-data/")), false);
});

test("site build fingerprint changes for frontend or mirror-manifest changes", async (t) => {
  const root = await createDist();
  t.after(() => rm(root, { recursive: true, force: true }));

  const initial = await createSiteBuildDescriptor(root);
  await writeFile(join(root, "assets/app.js"), "console.log('changed');\n", "utf8");
  const frontendChanged = await createSiteBuildDescriptor(root);
  assert.notEqual(frontendChanged.fingerprint, initial.fingerprint);

  await writeFile(join(root, "assets/app.js"), "console.log('hello');\n", "utf8");
  const mirrorDir = join(root, "mirror-data");
  await writeFile(join(mirrorDir, "status.json"), '{"ok":false}\n', "utf8");
  await writeManifest(mirrorDir);
  const mirrorChanged = await createSiteBuildDescriptor(root);
  assert.notEqual(mirrorChanged.fingerprint, initial.fingerprint);
  assert.notEqual(mirrorChanged.mirrorManifestSha256, initial.mirrorManifestSha256);
});

test("site build descriptor detects tampering", async (t) => {
  const root = await createDist();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeSiteBuildDescriptor(root);
  const path = join(root, SITE_BUILD_FILE);
  const payload = JSON.parse(await readFile(path, "utf8"));
  payload.files[0].bytes += 1;
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  await assert.rejects(() => readSiteBuildDescriptor(path), /fingerprint|totals\.bytes/u);
});
