export function inspectEntryTorrentIds(torrents) {
  if (!Array.isArray(torrents)) {
    throw new TypeError("torrents must be an array");
  }

  const seen = new Set();
  const duplicates = new Set();
  const missingIndexes = [];

  for (const [index, torrent] of torrents.entries()) {
    const id = typeof torrent?.id === "string" ? torrent.id.trim() : "";
    if (!id) {
      missingIndexes.push(index);
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }

  return {
    duplicates: [...duplicates].sort(),
    missingIndexes,
  };
}
