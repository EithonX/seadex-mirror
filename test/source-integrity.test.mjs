import assert from "node:assert/strict";
import test from "node:test";
import { validateSeaDexSnapshot, validateEntryTorrents } from "../scripts/lib/source-integrity.mjs";

function entry(alID, linkedIds, expandedIds = linkedIds) {
  return {
    alID,
    trs: [...linkedIds],
    expand: { trs: expandedIds.map((id) => ({ id })) },
  };
}

test("SeaDex parity accepts an exact ID and torrent-set match", () => {
  assert.doesNotThrow(() => validateSeaDexSnapshot([1, 2], [entry(1, ["a", "b"]), entry(2, [])]));
});

test("SeaDex parity rejects list/entry divergence in either direction", () => {
  assert.throws(() => validateSeaDexSnapshot([1, 2], [entry(1, [])]), /parity failure/);
  assert.throws(() => validateSeaDexSnapshot([1], [entry(1, []), entry(2, [])]), /parity failure/);
});

test("torrent parity rejects duplicate linked or expanded IDs", () => {
  assert.throws(() => validateEntryTorrents(entry(1, ["a", "a"], ["a", "b"])), /duplicate IDs/);
  assert.throws(() => validateEntryTorrents(entry(1, ["a", "b"], ["a", "a"])), /duplicate IDs/);
});

test("torrent parity rejects same-length but different torrent sets", () => {
  assert.throws(() => validateEntryTorrents(entry(1, ["a", "b"], ["a", "c"])), /missing from expand\.trs|not linked by trs/);
});
test("SeaDex integrity can validate the authoritative records collection without listIDs", () => {
  assert.doesNotThrow(() => validateSeaDexSnapshot([entry(1, ["a"]), entry(2, [])]));
  assert.throws(() => validateSeaDexSnapshot([entry(1, []), entry(1, [])]), /duplicate alIDs/);
});
