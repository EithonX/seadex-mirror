import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
const DEFAULT_ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const DEFAULT_SOURCE_PAGE_SIZE = 100;
const DEFAULT_ANILIST_BATCH_SIZE = 25;
const DEFAULT_ANILIST_DELAY_MS = 800;
const DEFAULT_RETRY_LIMIT = 5;
const DEFAULT_OUTPUT_DIR = "frontend/public/mirror-data";

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
  const anilistBatchSize = parsePositiveInt(args.batchSize, DEFAULT_ANILIST_BATCH_SIZE);
  const anilistDelayMs = parsePositiveInt(args.delayMs, DEFAULT_ANILIST_DELAY_MS);
  const retryLimit = parsePositiveInt(args.retryLimit, DEFAULT_RETRY_LIMIT);
  const outputDir = resolve(args.out ?? DEFAULT_OUTPUT_DIR);

  const startedAt = new Date().toISOString();
  const listIds = await fetchListIds(sourceBaseUrl);
  const sourceSnapshot = await fetchSourceSnapshot(sourceBaseUrl, pageSize);

  validateSourceSnapshot(listIds, sourceSnapshot.entries);

  const anilistMedia = await fetchAniListSnapshot(
    anilistUrl,
    sourceSnapshot.entries.map((entry) => entry.alID),
    anilistBatchSize,
    anilistDelayMs,
    retryLimit,
  );

  const finishedAt = new Date().toISOString();
  const snapshot = buildStaticSnapshot({
    sourceBaseUrl,
    startedAt,
    finishedAt,
    listIds,
    entries: sourceSnapshot.entries,
    anilistMedia,
  });

  await writeSnapshot(outputDir, snapshot);

  console.log(
    JSON.stringify(
      {
        mode: "static-snapshot",
        sourceBaseUrl,
        startedAt,
        finishedAt,
        outputDir,
        entries: snapshot.catalog.items.length,
        entryFiles: snapshot.catalog.items.length,
        torrents: snapshot.status.counts.torrents,
        anilistMedia: snapshot.status.counts.anilistMedia,
      },
      null,
      2,
    ),
  );
}

async function writeSnapshot(outputDir, snapshot) {
  const entriesDir = join(outputDir, "entries");

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });

  await writeJson(join(outputDir, "status.json"), snapshot.status);
  await writeJson(join(outputDir, "catalog.json"), snapshot.catalog);

  for (const [alId, payload] of snapshot.entries) {
    await writeJson(join(entriesDir, `${alId}.json`), payload);
  }
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function buildStaticSnapshot(snapshot) {
  const items = [];
  const entryPayloads = new Map();

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
        relations: Array.isArray(media?.relations?.edges) ? media.relations.edges : [],
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
        originalSite: "releases.moe",
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
        },
      },
    },
    catalog: {
      generatedAt: snapshot.finishedAt,
      items,
    },
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

function compareTorrentRows(left, right) {
  return (
    compareNumbers(right.isBest === true ? 1 : 0, left.isBest === true ? 1 : 0) ||
    compareStrings((left.releaseGroup ?? "").toLowerCase(), (right.releaseGroup ?? "").toLowerCase()) ||
    compareStrings(left.id ?? "", right.id ?? "")
  );
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

async function fetchAniListSnapshot(endpoint, ids, batchSize, delayMs, retryLimit) {
  const mediaMap = new Map();
  const batches = chunk(ids, batchSize);

  for (const [index, batch] of batches.entries()) {
    const payload = await withRetry(
      () => fetchAniListBatch(endpoint, batch),
      retryLimit,
      `AniList batch ${index + 1}/${batches.length}`,
    );

    for (const media of payload) {
      mediaMap.set(media.id, media);
    }

    if (index < batches.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return mediaMap;
}

async function fetchAniListBatch(endpoint, ids) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
