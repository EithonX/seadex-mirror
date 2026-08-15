import assert from "node:assert/strict";
import test from "node:test";
import {
  SEADEX_PRIVATE_TRACKERS,
  SEADEX_TRACKER_BASE_URLS,
  isSeaDexPrivateTracker,
  resolveSeaDexTorrentActionUrl,
  resolveSeaDexTorrentUrl,
} from "../shared/tracker-links.mjs";

test("AB relative URLs use SeaDex's tracker identity, not the SeaDex site origin", () => {
  assert.equal(
    resolveSeaDexTorrentUrl("AB", "torrents.php?id=41682&torrentid=1236786"),
    "https://animebytes.tv/torrents.php?id=41682&torrentid=1236786",
  );
});

test("known tracker-relative URLs resolve only against SeaDex's canonical tracker bases", () => {
  assert.equal(resolveSeaDexTorrentUrl("Nyaa", "12345"), "https://nyaa.si/view/12345");
  assert.equal(resolveSeaDexTorrentUrl("BeyondHD", "/torrents/123"), "https://beyond-hd.me/torrents/123");
  assert.equal(resolveSeaDexTorrentUrl("Aither", "torrents/456"), "https://aither.cc/torrents/456");
  assert.equal(resolveSeaDexTorrentUrl("PassThePopcorn", "torrents.php?id=9"), "https://passthepopcorn.me/torrents.php?id=9");
});

test("absolute database URLs remain authoritative and unsafe protocols are rejected", () => {
  assert.equal(
    resolveSeaDexTorrentUrl("OtherPrivate", "https://tracker.example/torrents.php?id=1"),
    "https://tracker.example/torrents.php?id=1",
  );
  assert.equal(resolveSeaDexTorrentUrl("Nyaa", "magnet:?xt=urn:btih:abc"), "magnet:?xt=urn:btih:abc");
  assert.equal(resolveSeaDexTorrentUrl("AB", "javascript:alert(1)"), null);
  assert.equal(resolveSeaDexTorrentUrl("AB", "//evil.example/torrents.php?id=1"), null);
});

test("Other/OtherPrivate relative URLs stay unresolved because SeaDex exposes no real canonical host", () => {
  assert.equal(resolveSeaDexTorrentUrl("Other", "view/1"), null);
  assert.equal(resolveSeaDexTorrentUrl("OtherPrivate", "torrents.php?id=1"), null);
});

test("frontend action resolution prefers raw PocketBase fields over legacy derived mirror URLs", () => {
  const torrent = {
    tracker: "AB",
    sourceUrl: "torrents.php?id=41682&torrentid=1236786",
    url: "https://releases.moe/torrents.php?id=41682&torrentid=1236786",
    sourceGroupedUrl: null,
    groupedUrl: null,
  };

  assert.equal(
    resolveSeaDexTorrentActionUrl(torrent),
    "https://animebytes.tv/torrents.php?id=41682&torrentid=1236786",
  );
});

test("tracker privacy classification follows SeaDex's tracker enum, not URL shape", () => {
  assert.deepEqual(SEADEX_PRIVATE_TRACKERS, [
    "OtherPrivate",
    "AB",
    "BeyondHD",
    "Aither",
    "Blutopia",
    "HDBits",
    "BroadcastTheNet",
    "PassThePopcorn",
  ]);
  for (const tracker of SEADEX_PRIVATE_TRACKERS) {
    assert.equal(isSeaDexPrivateTracker(tracker), true, tracker);
  }
  assert.equal(isSeaDexPrivateTracker("Nyaa"), false);
  assert.equal(isSeaDexPrivateTracker("RuTracker"), false);
  assert.equal(SEADEX_TRACKER_BASE_URLS.AB, "https://animebytes.tv/");
  assert.equal(Object.hasOwn(SEADEX_TRACKER_BASE_URLS, "OtherPrivate"), false);
});
