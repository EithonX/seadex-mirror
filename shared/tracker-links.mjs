const SAFE_TORRENT_PROTOCOLS = new Set(["https:", "http:", "magnet:"]);
const SAFE_TRACKER_BASE_PROTOCOLS = new Set(["https:", "http:"]);

/**
 * Canonical tracker bases mirrored from SeaDex's own
 * sk/src/lib/torrent/index.ts TRACKER_URL_MAP.
 *
 * SeaDex intentionally stores some tracker URLs as relative paths (notably AB;
 * see pb_migrations/1739215941_pt_origin_remove.js and
 * pb_migrations/1739375665_rename_2.js). The tracker enum is therefore part of
 * the URL identity for those records.
 *
 * "Other" and "OtherPrivate" are deliberately absent. SeaDex uses placeholder
 * example domains for those enum values, so there is no authoritative host to
 * reconstruct when their stored URL is relative.
 */
export const SEADEX_TRACKER_BASE_URLS = Object.freeze({
  Nyaa: "https://nyaa.si/view/",
  AB: "https://animebytes.tv/",
  AniDex: "https://anidex.info/torrent/",
  RuTracker: "https://rutracker.org/",
  AnimeTosho: "https://animetosho.org/",
  BeyondHD: "https://beyond-hd.me/",
  Aither: "https://aither.cc/",
  Blutopia: "https://blutopia.cc/",
  HDBits: "https://hdbits.org/",
  BroadcastTheNet: "https://broadcasthe.net/",
  PassThePopcorn: "https://passthepopcorn.me/",
});

/** Mirrors SeaDex's PRIVATE_TRACKERS list. */
export const SEADEX_PRIVATE_TRACKERS = Object.freeze([
  "OtherPrivate",
  "AB",
  "BeyondHD",
  "Aither",
  "Blutopia",
  "HDBits",
  "BroadcastTheNet",
  "PassThePopcorn",
]);

const PRIVATE_TRACKER_SET = new Set(SEADEX_PRIVATE_TRACKERS);

export function isSeaDexPrivateTracker(tracker) {
  return PRIVATE_TRACKER_SET.has(normalizeTrackerName(tracker));
}

/**
 * Resolve a torrent URL using only information SeaDex itself exposes.
 *
 * - Absolute http(s)/magnet URLs are authoritative and preserved regardless of
 *   tracker enum.
 * - Relative URLs are resolved only when SeaDex defines a concrete canonical
 *   base for that tracker.
 * - Unknown/OtherPrivate relative URLs stay unresolved rather than guessing a
 *   hostname.
 */
export function resolveSeaDexTorrentUrl(tracker, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }

  const absolute = parseSafeAbsoluteUrl(text);
  if (absolute) {
    return absolute;
  }

  // Protocol-relative URLs could switch away from the tracker origin and are
  // not the tracker-relative path form SeaDex stores.
  if (text.startsWith("//")) {
    return null;
  }

  const base = SEADEX_TRACKER_BASE_URLS[normalizeTrackerName(tracker)];
  if (!base) {
    return null;
  }

  try {
    const resolved = new URL(text, base);
    return SAFE_TRACKER_BASE_PROTOCOLS.has(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}


export function resolveSeaDexTorrentActionUrl(torrent, preferGrouped = false) {
  if (!torrent || typeof torrent !== "object") {
    return null;
  }

  const sourceValues = preferGrouped
    ? [torrent.sourceGroupedUrl, torrent.sourceUrl]
    : [torrent.sourceUrl, torrent.sourceGroupedUrl];
  const materializedValues = preferGrouped
    ? [torrent.groupedUrl, torrent.url]
    : [torrent.url, torrent.groupedUrl];

  // The source* fields preserve PocketBase verbatim. If either is present, do
  // not let a previously materialized/derived URL override it. This matters for
  // snapshots created before tracker-aware URL resolution existed.
  const candidates = sourceValues.some(hasText) ? sourceValues : materializedValues;
  for (const value of candidates) {
    const resolved = resolveSeaDexTorrentUrl(torrent.tracker, value);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTrackerName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseSafeAbsoluteUrl(value) {
  try {
    const url = new URL(value);
    return SAFE_TORRENT_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
