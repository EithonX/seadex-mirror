import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
const DEFAULT_ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const DEFAULT_SOURCE_PAGE_SIZE = 100;
const DEFAULT_SOURCE_PROBE_SIZE = 8;
const DEFAULT_ANILIST_BATCH_SIZE = 50;
const DEFAULT_ANILIST_DELAY_MS = 2200;
const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_OUTPUT_DIR = "frontend/public/mirror-data";
const PROGRESS_PREFIX = "[mirror-build]";
const UPSTREAM_TRACKER_ORDER = [
  "Nyaa",
  "AB",
  "AniDex",
  "RuTracker",
  "AnimeTosho",
  "BeyondHD",
  "Aither",
  "Blutopia",
  "HDBits",
  "BroadcastTheNet",
  "PassThePopcorn",
  "Other",
  "OtherPrivate",
];

const ANILIST_MEDIA_QUERY = `
  query($ids:[Int],$page:Int,$perPage:Int){
    Page(page:$page,perPage:$perPage){
      pageInfo{total}
      media(
        id_in:$ids,
        type:ANIME,
        sort:START_DATE_DESC,
        format_not:MUSIC,
        status_not_in:[NOT_YET_RELEASED,CANCELLED]
      ){
        id
        title{userPreferred english}
        coverImage{extraLarge color}
        season
        seasonYear
        startDate{year}
        format
        status
        episodes
        duration
        averageScore
        genres
        relations{
          edges{
            relationType
            node{
              id
              title{userPreferred english}
              coverImage{extraLarge color}
              seasonYear
              startDate{year}
              format
              status
              type
              episodes
            }
          }
        }
      }
    }
  }
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceBaseUrl = args.source ?? process.env.SOURCE_BASE_URL ?? DEFAULT_SOURCE_BASE_URL;
  const anilistUrl = args.anilist ?? process.env.ANILIST_GRAPHQL_URL ?? DEFAULT_ANILIST_GRAPHQL_URL;
  const pageSize = parsePositiveInt(args.pageSize, DEFAULT_SOURCE_PAGE_SIZE);
  const probeSize = parsePositiveInt(args.probeSize, DEFAULT_SOURCE_PROBE_SIZE);
  const anilistBatchSize = parsePositiveInt(args.batchSize, DEFAULT_ANILIST_BATCH_SIZE);
  const anilistDelayMs = parsePositiveInt(args.delayMs, DEFAULT_ANILIST_DELAY_MS);
  const retryLimit = parsePositiveInt(args.retryLimit, DEFAULT_RETRY_LIMIT);
  const anilistAccessToken = args.anilistToken ?? process.env.ANILIST_ACCESS_TOKEN ?? "";
  const anilistClientId = args.anilistClientId ?? process.env.ANILIST_CLIENT_ID ?? "";
  const anilistClientSecret = args.anilistClientSecret ?? process.env.ANILIST_CLIENT_SECRET ?? "";
  const statusUrl = args.statusUrl ?? process.env.MIRROR_STATUS_URL ?? "";
  const outputDir = resolve(args.out ?? DEFAULT_OUTPUT_DIR);
  const reportPath = args.report ? resolve(args.report) : "";
  const force = args.force === "true";
  const refreshAniList = args.refreshAniList === "true";

  warnAniListCredentialMode(anilistAccessToken, anilistClientId, anilistClientSecret);
  logStep(`Starting snapshot build${force ? " (forced)" : ""}.`);

  const startedAt = new Date().toISOString();
  const existingSnapshot = await loadExistingSnapshot(outputDir, statusUrl);
  logStep("Fetching SeaDex list IDs...");
  const listIds = await fetchListIds(sourceBaseUrl);
  logStep(`Fetched ${listIds.length} list IDs.`);
  logStep(`Fetching upstream probe (${probeSize} recent rows)...`);
  const sourceProbe = await fetchSourceProbe(sourceBaseUrl, probeSize);
  const probeSignature = buildProbeSignature(listIds, sourceProbe.items);
  logStep(`Computed upstream probe signature from ${sourceProbe.items.length} rows.`);

  if (!force && shouldSkipRebuild(existingSnapshot, probeSignature)) {
    const report = {
      mode: "static-snapshot",
      skipped: true,
      reason: "upstream-unchanged",
      sourceBaseUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      probeSignature,
      entries: existingSnapshot?.status?.counts?.entries ?? null,
      torrents: existingSnapshot?.status?.counts?.torrents ?? null,
    };
    await writeOptionalReport(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  logStep("Fetching full SeaDex entry snapshot...");
  const sourceSnapshot = await fetchSourceSnapshot(sourceBaseUrl, pageSize);
  logStep(`Fetched ${sourceSnapshot.entries.length} deduplicated entries.`);

  validateSourceSnapshot(listIds, sourceSnapshot.entries);
  logStep("Source parity checks passed.");

  logStep(
    `Fetching AniList metadata for ${sourceSnapshot.entries.length} entries in batches of ${anilistBatchSize} with ${anilistDelayMs}ms pacing...`,
  );
  const anilistMedia = await fetchAniListSnapshot(
    anilistUrl,
    sourceSnapshot.entries.map((entry) => entry.alID),
    anilistBatchSize,
    anilistDelayMs,
    retryLimit,
    anilistAccessToken,
    existingSnapshot?.aniListCache ?? new Map(),
    refreshAniList,
  );
  logStep(`Resolved AniList metadata for ${anilistMedia.size} entries.`);

  const finishedAt = new Date().toISOString();
  logStep("Composing static snapshot payloads...");
  const snapshot = buildStaticSnapshot({
    sourceBaseUrl,
    startedAt,
    finishedAt,
    listIds,
    entries: sourceSnapshot.entries,
    anilistMedia,
    sourceProbe,
    probeSignature,
  });

  logStep(`Writing snapshot files to ${outputDir}...`);
  await writeSnapshot(outputDir, snapshot);
  logStep("Snapshot files written successfully.");

  const report = {
    mode: "static-snapshot",
    skipped: false,
    sourceBaseUrl,
    startedAt,
    finishedAt,
    outputDir,
    entries: snapshot.catalog.items.length,
    entryFiles: snapshot.catalog.items.length,
    torrents: snapshot.status.counts.torrents,
    anilistMedia: snapshot.status.counts.anilistMedia,
  };
  await writeOptionalReport(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
}

async function loadExistingSnapshot(outputDir, statusUrl) {
  try {
    await access(join(outputDir, "status.json"));
    await access(join(outputDir, "anilist-cache.json"));
    await access(join(outputDir, "entries"));
  } catch {
    return loadRemoteStatus(statusUrl);
  }

  try {
    const status = JSON.parse(await readFile(join(outputDir, "status.json"), "utf8"));
    return {
      status,
      aniListCache: await loadAniListCacheFile(join(outputDir, "anilist-cache.json")),
    };
  } catch {
    return loadRemoteStatus(statusUrl);
  }
}

async function loadRemoteStatus(statusUrl) {
  if (!statusUrl) {
    return null;
  }

  try {
    const response = await fetch(statusUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }

    const status = await response.json();
    const cacheUrl = new URL("anilist-cache.json", statusUrl).toString();

    return {
      status,
      aniListCache: await loadRemoteAniListCache(cacheUrl),
    };
  } catch {
    return null;
  }
}

async function loadRemoteAniListCache(cacheUrl) {
  try {
    const response = await fetch(cacheUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return new Map();
    }

    return buildAniListCacheMap(await response.json());
  } catch {
    return new Map();
  }
}

async function loadAniListCacheFile(filePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8"));
    return buildAniListCacheMap(payload);
  } catch {
    return new Map();
  }
}

function buildAniListCacheMap(payload) {
  return new Map(
    Array.isArray(payload?.items)
      ? payload.items
          .filter((item) => Number.isInteger(item?.id) && item.id > 0)
          .map((item) => [item.id, item])
      : [],
  );
}

function shouldSkipRebuild(existingSnapshot, nextProbeSignature) {
  const previousSignature = existingSnapshot?.status?.sync?.summary?.upstreamProbe?.signature ?? null;
  return Boolean(previousSignature && previousSignature === nextProbeSignature);
}

function warnAniListCredentialMode(accessToken, clientId, clientSecret) {
  if (accessToken) {
    logStep("AniList mode: authenticated bearer token.");
    return;
  }

  if (clientId || clientSecret) {
    console.warn(
      `${PROGRESS_PREFIX} AniList mode: public GraphQL. AniList removed the client-credentials grant for public API data, so client ID/secret alone cannot authenticate snapshot fetches.`,
    );
    return;
  }

  logStep("AniList mode: public GraphQL.");
}

async function writeSnapshot(outputDir, snapshot) {
  const entriesDir = join(outputDir, "entries");

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });

  await writeJson(join(outputDir, "status.json"), snapshot.status);
  await writeJson(join(outputDir, "catalog.json"), snapshot.catalog);
  await writeJson(join(outputDir, "sheet.json"), snapshot.sheet);
  await writeJson(join(outputDir, "anilist-cache.json"), {
    generatedAt: snapshot.status.sync.lastRebuildFinishedAt,
    items: [...snapshot.anilistCache.values()],
  });

  let written = 0;
  const total = snapshot.entries.size;
  for (const [alId, payload] of snapshot.entries) {
    await writeJson(join(entriesDir, `${alId}.json`), payload);
    written += 1;
    if (written % 250 === 0 || written === total) {
      logStep(`Wrote ${written}/${total} entry files...`);
    }
  }
}

async function writeOptionalReport(reportPath, payload) {
  if (!reportPath) {
    return;
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeJson(reportPath, payload);
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function buildStaticSnapshot(snapshot) {
  const items = [];
  const sheetItems = [];
  const entryPayloads = new Map();
  const availableAnimeIds = new Set(snapshot.listIds);

  let torrentCount = 0;
  let missingAniListCount = 0;
  let zeroTorrentCount = 0;

  for (const entry of snapshot.entries) {
    const media = snapshot.anilistMedia.get(entry.alID) ?? null;
    const torrents = entry.expand?.trs ?? [];
    const bestTorrentCount = torrents.filter((torrent) => torrent.isBest === true).length;

    torrentCount += torrents.length;
    if (torrents.length === 0) {
      zeroTorrentCount += 1;
    }
    if (!media) {
      missingAniListCount += 1;
    }

    const catalogItem = {
      alId: entry.alID,
      recordId: entry.id,
      comparisonLinks: splitLinks(entry.comparison ?? ""),
      excerpt: summarizeNotes(entry.notes ?? ""),
      incomplete: entry.incomplete === true,
      sourceUpdatedAt: entry.updated,
      bestGroups: uniqueReleaseGroups(torrents.filter((torrent) => torrent.isBest)),
      altGroups: uniqueReleaseGroups(torrents.filter((torrent) => !torrent.isBest)),
      titles: buildTitles(entry.alID, media),
      coverImage: {
        extraLarge: media?.coverImage?.extraLarge ?? null,
        color: media?.coverImage?.color ?? null,
      },
      season: media?.season ?? null,
      seasonYear: media?.seasonYear ?? null,
      startYear: media?.startDate?.year ?? null,
      format: media?.format ?? null,
      status: media?.status ?? null,
      episodes: media?.episodes ?? null,
      averageScore: media?.averageScore ?? null,
      torrentCount: torrents.length,
      bestTorrentCount,
      searchText: buildSearchText(entry, media),
    };

    items.push(catalogItem);
    const bestGroups = catalogItem.bestGroups;
    const altGroups = catalogItem.altGroups;

    sheetItems.push({
      alId: entry.alID,
      recordId: entry.id,
      title: buildTitles(entry.alID, media).display,
      format: media?.format ?? null,
      status: media?.status ?? null,
      year: media?.startDate?.year ?? media?.seasonYear ?? null,
      episodes: media?.episodes ?? null,
      averageScore: media?.averageScore ?? null,
      incomplete: entry.incomplete === true,
      comparisonCount: splitLinks(entry.comparison ?? "").length,
      torrentCount: torrents.length,
      bestCount: bestTorrentCount,
      altCount: Math.max(0, torrents.length - bestTorrentCount),
      bestGroups,
      altGroups,
      excerpt: summarizeNotes(entry.notes ?? ""),
      updatedAt: entry.updated,
      searchText: buildSearchText(entry, media),
    });

    entryPayloads.set(entry.alID, {
      source: {
        originalSite: snapshot.sourceBaseUrl,
        originalEntryUrl: `${snapshot.sourceBaseUrl}/${entry.alID}/`,
      },
      entry: {
        alId: entry.alID,
        recordId: entry.id,
        comparisonLinks: splitLinks(entry.comparison ?? ""),
        notes: entry.notes ?? "",
        theoreticalBest: entry.theoreticalBest ?? null,
        incomplete: entry.incomplete === true,
        sourceCreatedAt: entry.created,
        sourceUpdatedAt: entry.updated,
        torrentCount: torrents.length,
        bestTorrentCount,
        titles: buildTitles(entry.alID, media),
        coverImage: {
          extraLarge: media?.coverImage?.extraLarge ?? null,
          color: media?.coverImage?.color ?? null,
        },
        season: media?.season ?? null,
        seasonYear: media?.seasonYear ?? null,
        startYear: media?.startDate?.year ?? null,
        format: media?.format ?? null,
        status: media?.status ?? null,
        episodes: media?.episodes ?? null,
        duration: media?.duration ?? null,
        averageScore: media?.averageScore ?? null,
        genres: Array.isArray(media?.genres) ? media.genres : [],
        relations: filterRelevantRelations(media?.relations?.edges, availableAnimeIds),
      },
      torrents: torrents
        .slice()
        .sort((left, right) => compareTorrentRows(left, right))
        .map((torrent) => ({
          id: torrent.id,
          releaseGroup: torrent.releaseGroup ?? "",
          tracker: torrent.tracker ?? "",
          sourceUrl: torrent.url ?? null,
          url: resolveSourceUrl(snapshot.sourceBaseUrl, torrent.url ?? "") || null,
          sourceGroupedUrl: torrent.groupedUrl ?? null,
          groupedUrl: resolveSourceUrl(snapshot.sourceBaseUrl, torrent.groupedUrl ?? "") || null,
          infoHash: torrent.infoHash ?? null,
          dualAudio: torrent.dualAudio === true,
          isBest: torrent.isBest === true,
          tags: Array.isArray(torrent.tags) ? torrent.tags : [],
          files: Array.isArray(torrent.files) ? torrent.files : [],
          sourceUpdatedAt: torrent.updated,
        })),
    });
  }

  return {
    status: {
      mirror: {
        sourceBaseUrl: snapshot.sourceBaseUrl,
        originalSite: snapshot.sourceBaseUrl,
        attribution: "SeaDex data originates from releases.moe. AniList metadata is cached by this mirror.",
        disclaimer: "This is an unofficial community mirror built to stay readable when the upstream frontend or AniList path is unstable.",
      },
      counts: {
        entries: snapshot.entries.length,
        torrents: torrentCount,
        anilistMedia: snapshot.anilistMedia.size,
      },
      integrity: {
        entriesWithoutTorrents: zeroTorrentCount,
        entriesWithoutAniList: missingAniListCount,
        sourceListIdCount: snapshot.listIds.length,
        sourceEntryCount: snapshot.entries.length,
        sourceTorrentCount: torrentCount,
        listIdParity: "match",
        expandedTorrentParity: "match",
      },
      sync: {
        lastRebuildStartedAt: snapshot.startedAt,
        lastRebuildFinishedAt: snapshot.finishedAt,
        lastRebuildMode: "static-snapshot",
        lastError: null,
        summary: {
          mode: "static-snapshot",
          sourceBaseUrl: snapshot.sourceBaseUrl,
          startedAt: snapshot.startedAt,
          finishedAt: snapshot.finishedAt,
          entries: snapshot.entries.length,
          torrents: torrentCount,
          anilistMedia: snapshot.anilistMedia.size,
          upstreamProbe: {
            size: snapshot.sourceProbe.items.length,
            signature: snapshot.probeSignature,
          },
        },
      },
    },
    catalog: {
      generatedAt: snapshot.finishedAt,
      items,
    },
    sheet: {
      generatedAt: snapshot.finishedAt,
      items: sheetItems.sort((left, right) => {
        return (
          compareNumbers(Date.parse(right.updatedAt), Date.parse(left.updatedAt)) ||
          compareStrings(left.title.toLowerCase(), right.title.toLowerCase())
        );
      }),
    },
    anilistCache: snapshot.anilistMedia,
    entries: entryPayloads,
  };
}

function buildTitles(alId, media) {
  return {
    userPreferred: media?.title?.userPreferred ?? null,
    english: media?.title?.english ?? null,
    display: media?.title?.english ?? media?.title?.userPreferred ?? String(alId),
  };
}

function buildSearchText(entry, media) {
  return [
    media?.title?.english ?? "",
    media?.title?.userPreferred ?? "",
    entry.notes ?? "",
    entry.alID,
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueReleaseGroups(torrents) {
  return [...new Set(sortTorrentsLikeUpstream(torrents).map((torrent) => torrent?.releaseGroup ?? "").filter(Boolean))].slice(0, 2);
}

function compareTorrentRows(left, right) {
  return compareTorrentsLikeUpstream(left, right);
}

function sortTorrentsLikeUpstream(torrents) {
  return torrents.slice().sort(compareTorrentsLikeUpstream);
}

function compareTorrentsLikeUpstream(left, right) {
  return (
    compareNumbers(right.isBest === true ? 1 : 0, left.isBest === true ? 1 : 0) ||
    compareNumbers(left.dualAudio === true ? 1 : 0, right.dualAudio === true ? 1 : 0) ||
    compareNumbers(trackerPriorityIndex(left.tracker ?? ""), trackerPriorityIndex(right.tracker ?? "")) ||
    compareStrings((left.releaseGroup ?? "").toLowerCase(), (right.releaseGroup ?? "").toLowerCase()) ||
    compareStrings(left.id ?? "", right.id ?? "")
  );
}

function trackerPriorityIndex(tracker) {
  const index = UPSTREAM_TRACKER_ORDER.indexOf(tracker);
  return index === -1 ? UPSTREAM_TRACKER_ORDER.length : index;
}

function compareNumbers(left, right) {
  return left - right;
}

function compareStrings(left, right) {
  return left.localeCompare(right);
}

async function fetchListIds(sourceBaseUrl) {
  const response = await fetch(new URL("/api/listIDs", sourceBaseUrl), {
    headers: { accept: "text/plain" },
  });
  if (!response.ok) {
    throw new Error(`SeaDex listIDs fetch failed with ${response.status} ${response.statusText}`);
  }

  return response
    .text()
    .then((text) =>
      text
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
}

async function fetchSourceProbe(sourceBaseUrl, pageSize) {
  const endpoint = new URL("/api/collections/entries/records", sourceBaseUrl);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("perPage", String(pageSize));
  endpoint.searchParams.set("sort", "-updated");
  endpoint.searchParams.set("skipTotal", "1");

  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`SeaDex probe fetch failed with ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
  };
}

function buildProbeSignature(listIds, items) {
  const probeRecords = items.map((item) => `${item.alID}:${item.updated}`).join("|");
  return `ids=${listIds.join(",")};probe=${probeRecords}`;
}

async function fetchSourceSnapshot(sourceBaseUrl, pageSize) {
  const endpoint = new URL("/api/collections/entries/records", sourceBaseUrl);
  const entries = [];
  let page = 1;

  while (true) {
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("perPage", String(pageSize));
    endpoint.searchParams.set("sort", "-updated");
    endpoint.searchParams.set("skipTotal", "1");
    endpoint.searchParams.set("expand", "trs");

    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`SeaDex entries fetch failed with ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const items = payload.items ?? [];
    entries.push(...items);
    logStep(`Fetched source page ${page} with ${items.length} rows (${entries.length} accumulated).`);

    if (items.length < pageSize) {
      break;
    }
    page += 1;
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.alID)) {
      continue;
    }
    seen.add(entry.alID);
    deduped.push(entry);
  }

  return {
    entries: deduped,
  };
}

function validateSourceSnapshot(listIds, entries) {
  const listIdSet = new Set(listIds);
  const entryIdSet = new Set(entries.map((entry) => entry.alID));

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

  for (const entry of entries) {
    const expandedTorrents = entry.expand?.trs ?? [];
    const linkedTorrentIds = Array.isArray(entry.trs) ? entry.trs : [];

    if (expandedTorrents.length !== linkedTorrentIds.length) {
      throw new Error(
        `SeaDex torrent parity failure for AniList ${entry.alID}: trs has ${linkedTorrentIds.length} ids but expand.trs returned ${expandedTorrents.length} rows.`,
      );
    }

    const expandedIds = new Set(expandedTorrents.map((torrent) => torrent.id));
    for (const torrentId of linkedTorrentIds) {
      if (!expandedIds.has(torrentId)) {
        throw new Error(
          `SeaDex torrent parity failure for AniList ${entry.alID}: linked torrent ${torrentId} is missing from expand.trs.`,
        );
      }
    }
  }
}

async function fetchAniListSnapshot(endpoint, ids, batchSize, delayMs, retryLimit, accessToken, existingCache, refreshAniList) {
  const mediaMap = new Map();
  const missingIds = [];

  if (!refreshAniList) {
    for (const id of ids) {
      const cached = existingCache.get(id) ?? null;
      if (cached) {
        mediaMap.set(id, cached);
        continue;
      }
      missingIds.push(id);
    }
  } else {
    missingIds.push(...ids);
  }

  if (mediaMap.size) {
    logStep(`Reused cached AniList metadata for ${mediaMap.size}/${ids.length} entries.`);
  } else if (refreshAniList) {
    logStep(`AniList cache refresh requested for ${ids.length} entries.`);
  }

  const batches = chunk(missingIds, batchSize);
  if (batches.length === 0) {
    return mediaMap;
  }

  for (const [index, batch] of batches.entries()) {
    let payload;
    logStep(`AniList batch ${index + 1}/${batches.length} starting (${batch.length} ids).`);

    try {
      payload = await withRetry(
        () => fetchAniListBatch(endpoint, batch, accessToken),
        retryLimit,
        `AniList batch ${index + 1}/${batches.length}`,
      );
    } catch (error) {
      if (accessToken) {
        console.warn(`AniList token mode failed for batch ${index + 1}/${batches.length}. Falling back to public mode.`);
        try {
          payload = await withRetry(
            () => fetchAniListBatch(endpoint, batch, ""),
            retryLimit,
            `AniList public batch ${index + 1}/${batches.length}`,
          );
        } catch {
          payload = resolveCachedAniListBatch(batch, existingCache);
        }
      } else {
        payload = resolveCachedAniListBatch(batch, existingCache);
      }

      if (!payload.length) {
        throw error;
      }
    }

    for (const media of payload) {
      mediaMap.set(media.id, media);
    }
    logStep(`AniList batch ${index + 1}/${batches.length} finished (${payload.length} records, ${mediaMap.size} total).`);

    if (index < batches.length - 1 && delayMs > 0) {
      logStep(`Waiting ${delayMs}ms before next AniList batch...`);
      await sleep(delayMs);
    }
  }

  return mediaMap;
}

async function fetchAniListBatch(endpoint, ids, accessToken) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };

  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: ANILIST_MEDIA_QUERY,
      variables: {
        ids,
        page: 1,
        perPage: ids.length,
      },
    }),
  });

  if (!response.ok) {
    const message = `AniList fetch failed with ${response.status} ${response.statusText}`;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : null;
    const error = new Error(message);
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message ?? "Unknown AniList error").join("; "));
  }

  return payload.data?.Page?.media ?? [];
}

function resolveCachedAniListBatch(ids, existingCache) {
  const cached = ids
    .map((id) => existingCache.get(id) ?? null)
    .filter(Boolean);

  if (cached.length) {
    console.warn(`Using cached AniList metadata for ${cached.length}/${ids.length} entries.`);
  }

  return cached;
}

async function withRetry(work, retryLimit, label) {
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt === retryLimit) {
        throw error;
      }

      const retryAfterMs =
        typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
          ? error.retryAfterMs
          : 1500 * (attempt + 1);

      console.warn(`${label} failed on attempt ${attempt + 1}. Retrying in ${retryAfterMs}ms.`);
      await sleep(retryAfterMs);
    }
  }

  throw new Error(`${label} exhausted retries.`);
}

function resolveSourceUrl(sourceBaseUrl, value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, sourceBaseUrl).toString();
  } catch {
    return value;
  }
}

function splitLinks(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeNotes(value) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function filterRelevantRelations(edges, availableAnimeIds) {
  if (!Array.isArray(edges)) {
    return [];
  }

  return edges.filter((edge) => {
    const node = edge?.node;
    return (
      node?.id &&
      availableAnimeIds.has(node.id) &&
      (node.type === undefined || node.type === null || node.type === "ANIME")
    );
  });
}

function parseArgs(rawArgs) {
  const args = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function logStep(message) {
  console.log(`${PROGRESS_PREFIX} ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
