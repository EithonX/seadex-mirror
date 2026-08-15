import assert from "node:assert/strict";
import test from "node:test";
import { validateSeaDexSnapshot, validateEntryTorrents } from "../scripts/lib/source-integrity.mjs";

function entry(alID, torrentIds = []) {
  return {
    alID,
    trs: torrentIds,
    expand: { trs: torrentIds.map((id) => ({ id })) },
  };
}

test("SeaDex parity accepts an exact ID and torrent-set match", () => {
  assert.doesNotThrow(() => validateSeaDexSnapshot([1, 2], [entry(1, ["a", "b"]), entry(2, [])]));
});

test("SeaDex parity rejects list/entry divergence in either direction", () => {
  assert.throws(() => validateSeaDexSnapshot([1, 2], [entry(1, [])]), /parity failure/);
  assert.throws(() => validateSeaDexSnapshot([1], [entry(1, []), entry(2, [])]), /parity failure/);
});

test("SeaDex parity rejects duplicate or invalid source IDs", () => {
  assert.throws(() => validateSeaDexSnapshot([1, 1], [entry(1)]), /duplicate IDs/);
  assert.throws(() => validateSeaDexSnapshot([0], [entry(0)]), /invalid ID/);
  assert.throws(() => validateSeaDexSnapshot([1], [entry(1), entry(1)]), /duplicate alIDs/);
});

test("torrent parity rejects duplicate linked or expanded IDs", () => {
  assert.throws(() => validateEntryTorrents(entry(1, ["a", "a"])), /duplicate IDs/);

  const duplicatedExpanded = entry(1, ["a", "b"]);
  duplicatedExpanded.expand.trs = [{ id: "a" }, { id: "a" }];
  assert.throws(() => validateEntryTorrents(duplicatedExpanded), /duplicate IDs/);
});

test("torrent parity rejects same-length but different torrent sets", () => {
  const mismatched = entry(1, ["a", "b"]);
  mismatched.expand.trs = [{ id: "a" }, { id: "c" }];
  assert.throws(() => validateEntryTorrents(mismatched), /missing from expand\.trs|not linked by trs/);
});
