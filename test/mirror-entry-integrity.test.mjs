import assert from "node:assert/strict";
import test from "node:test";
import { inspectEntryTorrentIds } from "../scripts/lib/mirror-entry-integrity.mjs";

test("entry torrent inspection rejects duplicates only within the same entry", () => {
  const firstEntry = inspectEntryTorrentIds([{ id: "shared" }, { id: "unique-a" }]);
  const secondEntry = inspectEntryTorrentIds([{ id: "shared" }, { id: "unique-b" }]);

  assert.deepEqual(firstEntry, { duplicates: [], missingIndexes: [] });
  assert.deepEqual(secondEntry, { duplicates: [], missingIndexes: [] });
});

test("entry torrent inspection reports duplicate IDs within one entry", () => {
  const result = inspectEntryTorrentIds([
    { id: "torrent-a" },
    { id: "torrent-b" },
    { id: "torrent-a" },
    { id: "torrent-a" },
  ]);

  assert.deepEqual(result, { duplicates: ["torrent-a"], missingIndexes: [] });
});

test("entry torrent inspection reports missing IDs without confusing them with duplicates", () => {
  const result = inspectEntryTorrentIds([{ id: "torrent-a" }, { id: "" }, {}, null]);

  assert.deepEqual(result, { duplicates: [], missingIndexes: [1, 2, 3] });
});
