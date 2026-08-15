export function validateSeaDexSnapshot(listIds, entries) {
  if (!Array.isArray(listIds)) {
    throw new TypeError("SeaDex listIDs must be an array.");
  }
  if (!Array.isArray(entries)) {
    throw new TypeError("SeaDex entries must be an array.");
  }

  const listIdSet = new Set(listIds);
  if (listIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("SeaDex listIDs contains an invalid ID.");
  }
  if (listIdSet.size !== listIds.length) {
    throw new Error("SeaDex listIDs contains duplicate IDs.");
  }

  const entryIds = entries.map((entry) => entry?.alID);
  const entryIdSet = new Set(entryIds);
  if (entryIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("SeaDex entries contain a row without a valid alID.");
  }
  if (entryIdSet.size !== entries.length) {
    throw new Error("SeaDex entries contain duplicate alIDs.");
  }

  if (listIdSet.size !== entryIdSet.size) {
    throw new Error(
      `SeaDex parity failure: listIDs has ${listIdSet.size} ids but expanded entries returned ${entryIdSet.size}.`,
    );
  }

  for (const id of listIdSet) {
    if (!entryIdSet.has(id)) {
      throw new Error(`SeaDex parity failure: AniList ${id} exists in listIDs but not in expanded entries.`);
    }
  }
  for (const id of entryIdSet) {
    if (!listIdSet.has(id)) {
      throw new Error(`SeaDex parity failure: expanded AniList ${id} does not exist in listIDs.`);
    }
  }

  for (const entry of entries) {
    validateEntryTorrents(entry);
  }
}

export function validateEntryTorrents(entry) {
  const alId = entry?.alID ?? "unknown";
  const expandedTorrents = Array.isArray(entry?.expand?.trs) ? entry.expand.trs : [];
  const linkedTorrentIds = Array.isArray(entry?.trs) ? entry.trs : [];

  if (expandedTorrents.length !== linkedTorrentIds.length) {
    throw new Error(
      `SeaDex torrent parity failure for AniList ${alId}: trs has ${linkedTorrentIds.length} ids but expand.trs returned ${expandedTorrents.length} rows.`,
    );
  }

  const linkedIds = new Set(linkedTorrentIds);
  const expandedIdList = expandedTorrents.map((torrent) => torrent?.id);
  const expandedIds = new Set(expandedIdList);

  if (linkedIds.has(undefined) || linkedIds.has(null) || linkedIds.has("")) {
    throw new Error(`SeaDex torrent parity failure for AniList ${alId}: trs contains an invalid ID.`);
  }
  if (linkedIds.size !== linkedTorrentIds.length) {
    throw new Error(`SeaDex torrent parity failure for AniList ${alId}: trs contains duplicate IDs.`);
  }
  if (expandedIds.has(undefined) || expandedIds.has(null) || expandedIds.has("")) {
    throw new Error(`SeaDex torrent parity failure for AniList ${alId}: expand.trs contains a row without an ID.`);
  }
  if (expandedIds.size !== expandedIdList.length) {
    throw new Error(`SeaDex torrent parity failure for AniList ${alId}: expand.trs contains duplicate IDs.`);
  }

  for (const torrentId of linkedIds) {
    if (!expandedIds.has(torrentId)) {
      throw new Error(
        `SeaDex torrent parity failure for AniList ${alId}: linked torrent ${torrentId} is missing from expand.trs.`,
      );
    }
  }
  for (const torrentId of expandedIds) {
    if (!linkedIds.has(torrentId)) {
      throw new Error(
        `SeaDex torrent parity failure for AniList ${alId}: expanded torrent ${torrentId} is not linked by trs.`,
      );
    }
  }
}
