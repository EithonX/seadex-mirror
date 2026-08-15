import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSeaDexFingerprint,
  buildSnapshotId,
  buildSourceFingerprint,
  buildWorkbookContentFingerprint,
  createSnapshotManifest,
  sha256Text,
  verifySnapshotManifest,
} from "../scripts/lib/snapshot-integrity.mjs";

function entry(alID, torrentId, updated = "2026-08-15T00:00:00Z") {
  return {
    alID,
    id: `entry-${alID}`,
    updated,
    trs: [torrentId],
    expand: { trs: [{ id: torrentId, tracker: "Nyaa", updated }] },
  };
}

test("SeaDex fingerprint is order-independent for entries and detects torrent changes", () => {
  const first = buildSeaDexFingerprint([2, 1], [entry(2, "t2"), entry(1, "t1")]);
  const reordered = buildSeaDexFingerprint([1, 2], [entry(1, "t1"), entry(2, "t2")]);
  const torrentChanged = buildSeaDexFingerprint([1, 2], [entry(1, "t1-new"), entry(2, "t2")]);
  assert.equal(first, reordered);
  assert.notEqual(first, torrentChanged);
});

test("workbook content fingerprint ignores generation time but detects represented changes", () => {
  const first = buildWorkbookContentFingerprint({
    generatedAt: "2026-08-15T00:00:00Z",
    sheets: [{ name: "Main", rows: [["same"]] }],
  });
  const timestampOnly = buildWorkbookContentFingerprint({
    generatedAt: "2026-08-16T00:00:00Z",
    sheets: [{ name: "Main", rows: [["same"]] }],
  });
  const changed = buildWorkbookContentFingerprint({
    generatedAt: "2026-08-16T00:00:00Z",
    sheets: [{ name: "Main", rows: [["changed"]] }],
  });

  assert.equal(first, timestampOnly);
  assert.notEqual(first, changed);
});

test("source fingerprint tracks normalized workbook content", () => {
  const seaDexFingerprint = sha256Text("same-seadex");
  assert.notEqual(
    buildSourceFingerprint({
      seaDexFingerprint,
      workbookContentSha256: buildWorkbookContentFingerprint({ sheets: [{ name: "A" }] }),
    }),
    buildSourceFingerprint({
      seaDexFingerprint,
      workbookContentSha256: buildWorkbookContentFingerprint({ sheets: [{ name: "B" }] }),
    }),
  );
});

test("snapshot identity includes rendered workbook content but ignores its timestamp", () => {
  const sourceFingerprint = sha256Text("source");
  const aniListMedia = new Map([[1, { id: 1, title: { english: "Example" } }]]);
  const base = buildSnapshotId({
    sourceFingerprint,
    aniListMedia,
    sheetWorkbook: { generatedAt: "2026-08-15T00:00:00Z", sheets: [{ name: "Main", rows: [] }] },
  });
  const timestampOnly = buildSnapshotId({
    sourceFingerprint,
    aniListMedia,
    sheetWorkbook: { generatedAt: "2026-08-16T00:00:00Z", sheets: [{ name: "Main", rows: [] }] },
  });
  const contentChanged = buildSnapshotId({
    sourceFingerprint,
    aniListMedia,
    sheetWorkbook: { generatedAt: "2026-08-16T00:00:00Z", sheets: [{ name: "Changed", rows: [] }] },
  });

  assert.equal(base, timestampOnly);
  assert.notEqual(base, contentChanged);
});

test("manifest verifies every file and detects mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "seadex-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "entries"));
  await writeFile(join(root, "status.json"), "{}\n");
  await writeFile(join(root, "entries", "1.json"), '{"entry":{"alId":1}}\n');

  const digest = sha256Text("snapshot");
  const manifest = await createSnapshotManifest(root, {
    snapshotId: digest,
    sourceFingerprint: digest,
    generatedAt: "2026-08-15T00:00:00Z",
  });
  const verified = await verifySnapshotManifest(root, manifest);
  assert.equal(verified.files, 2);

  await writeFile(join(root, "entries", "1.json"), '{"entry":{"alId":2}}\n');
  await assert.rejects(verifySnapshotManifest(root, manifest), /mismatch/u);
});

test("manifest rejects path traversal before touching files outside the snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "seadex-manifest-path-"));
  try {
    await writeFile(join(root, "status.json"), "{}\n");
    const manifest = {
      schemaVersion: 1,
      algorithm: "sha256",
      snapshotId: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      generatedAt: new Date().toISOString(),
      totals: { files: 1, bytes: 2 },
      files: [{ path: "../escape.json", bytes: 2, sha256: "c".repeat(64) }],
    };

    await assert.rejects(() => verifySnapshotManifest(root, manifest), /Unsafe snapshot manifest path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
