import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { replaceDirectoryAtomically, pathExists } from "./lib/atomic-directory.mjs";
import { HttpRequestError, fetchWithRetry, readJsonResponse, readResponseBuffer, readTextResponse } from "./lib/http.mjs";
import { fetchConsistentSeaDexSnapshot } from "./lib/seadex-source.mjs";
import {
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshotId,
  buildSourceFingerprint,
  buildWorkbookContentFingerprint,
  createSnapshotManifest,
  readSnapshotManifest,
  sha256Buffer,
  validateSnapshotManifest,
  verifySnapshotManifest,
} from "./lib/snapshot-integrity.mjs";

const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
const DEFAULT_ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const DEFAULT_SHEET_WORKBOOK_URL =
  "https://docs.google.com/spreadsheets/d/1emW2Zsb0gEtEHiub_YHpazvBd4lL4saxCwyPhbtxXYM/export?format=xlsx";
const DEFAULT_SOURCE_PAGE_SIZE = 500;
const DEFAULT_ANILIST_BATCH_SIZE = 50;
const DEFAULT_ANILIST_DELAY_MS = 2200;
const DEFAULT_RETRY_LIMIT = 4;
const DEFAULT_ANILIST_CACHE_TTL_HOURS = 168;
const DEFAULT_SOURCE_CAPTURE_ATTEMPTS = 4;
const MAX_SOURCE_JSON_BYTES = 32 * 1024 * 1024;
const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024;
const MAX_PUBLISHED_SHEET_HTML_BYTES = 16 * 1024 * 1024;
const DEFAULT_OUTPUT_DIR = "frontend/public/mirror-data";
const DEFAULT_ON_UNCHANGED = "skip";
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
  const sourceBaseUrl = requireHttpUrl(
    args.source ?? process.env.SOURCE_BASE_URL ?? DEFAULT_SOURCE_BASE_URL,
    "SeaDex source URL",
  );
  const anilistUrl = requireHttpUrl(
    args.anilist ?? process.env.ANILIST_GRAPHQL_URL ?? DEFAULT_ANILIST_GRAPHQL_URL,
    "AniList GraphQL URL",
  );
  const pageSize = parsePositiveInt(args.pageSize, DEFAULT_SOURCE_PAGE_SIZE);
  const anilistBatchSize = parsePositiveInt(args.batchSize, DEFAULT_ANILIST_BATCH_SIZE);
  const anilistDelayMs = parseNonNegativeInt(args.delayMs, DEFAULT_ANILIST_DELAY_MS);
  const retryLimit = parseNonNegativeInt(args.retryLimit, DEFAULT_RETRY_LIMIT);
  const anilistCacheTtlHours = parsePositiveInt(
    args.anilistCacheTtlHours ?? process.env.ANILIST_CACHE_TTL_HOURS,
    DEFAULT_ANILIST_CACHE_TTL_HOURS,
  );
  const sourceCaptureAttempts = parsePositiveInt(
    args.sourceCaptureAttempts,
    DEFAULT_SOURCE_CAPTURE_ATTEMPTS,
  );
  const anilistAccessToken = args.anilistToken ?? process.env.ANILIST_ACCESS_TOKEN ?? "";
  const anilistClientId = args.anilistClientId ?? process.env.ANILIST_CLIENT_ID ?? "";
  const anilistClientSecret = args.anilistClientSecret ?? process.env.ANILIST_CLIENT_SECRET ?? "";
  const rawStatusUrl = args.statusUrl ?? process.env.MIRROR_STATUS_URL ?? "";
  const statusUrl = rawStatusUrl ? requireHttpUrl(rawStatusUrl, "Mirror status URL") : "";
  const sheetWorkbookUrl = requireHttpUrl(
    args.sheetWorkbookUrl ?? process.env.SHEET_WORKBOOK_URL ?? DEFAULT_SHEET_WORKBOOK_URL,
    "Sheet workbook URL",
  );
  const outputDir = resolve(args.out ?? DEFAULT_OUTPUT_DIR);
  const reportPath = args.report ? resolve(args.report) : "";
  const force = args.force === "true";
  const refreshAniList = args.refreshAniList === "true";
  const onUnchanged = resolveOnUnchangedBehavior(args);

  warnAniListCredentialMode(anilistAccessToken, anilistClientId, anilistClientSecret);
  logStep(`Starting snapshot build${force ? " (forced)" : ""}.`);

  const startedAt = new Date().toISOString();
  const localSnapshot = await loadLocalSnapshot(outputDir);
  const remoteSnapshot = localSnapshot ? null : await loadRemoteStatus(statusUrl, retryLimit);
  const existingSnapshot = localSnapshot ?? remoteSnapshot;

  logStep(`Capturing a consistent SeaDex snapshot (up to ${sourceCaptureAttempts} attempt(s))...`);
  const sourceSnapshot = await fetchConsistentSeaDexSnapshot({
    sourceBaseUrl,
    pageSize,
    maxAttempts: sourceCaptureAttempts,
    retryLimit,
    maxResponseBytes: MAX_SOURCE_JSON_BYTES,
    log: logStep,
  });
  logStep(
    `Consistent SeaDex snapshot confirmed: ${sourceSnapshot.entries.length} entries on capture attempt ${sourceSnapshot.captureAttempt}, fingerprint ${sourceSnapshot.seaDexFingerprint.slice(0, 12)}.`,
  );

  logStep("Fetching published SeaDex sheet workbook...");
  const sheetSnapshot = await fetchSheetWorkbookSnapshot(sheetWorkbookUrl, retryLimit);
  logStep(
    `Workbook snapshot ready with ${sheetSnapshot.payload.sheets.length} tab(s), content fingerprint ${sheetSnapshot.contentSha256.slice(0, 12)}.`,
  );

  const sourceFingerprint = buildSourceFingerprint({
    seaDexFingerprint: sourceSnapshot.seaDexFingerprint,
    workbookContentSha256: sheetSnapshot.contentSha256,
  });
  const aniListRefreshDue = hasAniListRefreshDue(
    existingSnapshot?.aniListCache ?? new Map(),
    sourceSnapshot.entries.map((entry) => entry.alID),
    anilistCacheTtlHours,
    refreshAniList,
  );
  const upstreamUnchanged =
    !force && shouldSkipRebuild(existingSnapshot, sourceFingerprint) && !aniListRefreshDue;
  const shouldMaterializeSnapshot = upstreamUnchanged && onUnchanged === "materialize" && !localSnapshot;

  if (upstreamUnchanged && !shouldMaterializeSnapshot) {
    const report = {
      action: "skipped",
      mode: "static-snapshot",
      skipped: true,
      reason: "authoritative-source-unchanged",
      sourceBaseUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceFingerprint,
      snapshotId: existingSnapshot?.status?.snapshot?.id ?? null,
      snapshotSource: existingSnapshot?.origin ?? null,
      localSnapshotReady: Boolean(localSnapshot),
      onUnchanged,
      entries: existingSnapshot?.status?.counts?.entries ?? null,
      torrents: existingSnapshot?.status?.counts?.torrents ?? null,
      aniListCacheRefreshDue: false,
    };
    await writeOptionalReport(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (shouldMaterializeSnapshot) {
    logStep(
      `Authoritative inputs are unchanged, but local mirror data is unavailable. Reconstructing the known snapshot using the ${existingSnapshot?.origin ?? "available"} AniList cache.`,
    );
  }

  logStep(
    `Resolving AniList metadata for ${sourceSnapshot.entries.length} entries in batches of ${anilistBatchSize} with ${anilistDelayMs}ms pacing...`,
  );
  const anilistResult = await fetchAniListSnapshot(
    anilistUrl,
    sourceSnapshot.entries.map((entry) => entry.alID),
    anilistBatchSize,
    anilistDelayMs,
    retryLimit,
    anilistAccessToken,
    existingSnapshot?.aniListCache ?? new Map(),
    refreshAniList,
    anilistCacheTtlHours,
  );
  logStep(
    `AniList metadata ready for ${anilistResult.media.size} entries (${anilistResult.stats.reusedFresh} fresh cache, ${anilistResult.stats.fetched} refreshed, ${anilistResult.stats.staleFallback} stale fallback).`,
  );

  const priorStartedAt = existingSnapshot?.status?.sync?.lastRebuildStartedAt ?? null;
  const priorFinishedAt = existingSnapshot?.status?.sync?.lastRebuildFinishedAt ?? null;
  const effectiveStartedAt = shouldMaterializeSnapshot && priorStartedAt ? priorStartedAt : startedAt;
  const finishedAt =
    shouldMaterializeSnapshot && priorFinishedAt ? priorFinishedAt : new Date().toISOString();
  const snapshotId = buildSnapshotId({
    sourceFingerprint,
    aniListMedia: anilistResult.media,
    sheetWorkbook: sheetSnapshot.payload,
  });
  sheetSnapshot.payload.generatedAt = finishedAt;

  logStep(`Composing static snapshot ${snapshotId.slice(0, 12)}...`);
  const snapshot = buildStaticSnapshot({
    sourceBaseUrl,
    startedAt: effectiveStartedAt,
    finishedAt,
    listIds: sourceSnapshot.listIds,
    entries: sourceSnapshot.entries,
    anilistMedia: anilistResult.media,
    anilistCache: anilistResult.cache,
    anilistStats: anilistResult.stats,
    sheetWorkbook: sheetSnapshot.payload,
    sourceFingerprint,
    snapshotId,
  });

  logStep(`Writing snapshot files to ${outputDir}...`);
  const manifest = await writeSnapshot(outputDir, snapshot);
  logStep(
    `Snapshot files written and hashed successfully (${manifest.totals.files} files, ${formatBytes(manifest.totals.bytes)}).`,
  );

  const report = {
    action: shouldMaterializeSnapshot ? "materialized" : "rebuilt",
    mode: "static-snapshot",
    skipped: false,
    sourceBaseUrl,
    startedAt: effectiveStartedAt,
    finishedAt,
    outputDir,
    snapshotId,
    sourceFingerprint,
    snapshotSource: existingSnapshot?.origin ?? null,
    localSnapshotReady: true,
    onUnchanged,
    entries: snapshot.catalog.items.length,
    entryFiles: snapshot.catalog.items.length,
    torrents: snapshot.status.counts.torrents,
    anilistMedia: snapshot.status.counts.anilistMedia,
    anilistCache: anilistResult.stats,
    sheetTabs: snapshot.sheetWorkbook.sheets.length,
    manifestFiles: manifest.totals.files,
    manifestBytes: manifest.totals.bytes,
  };
  await writeOptionalReport(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
}
async function loadLocalSnapshot(outputDir) {
  try {
    const statusPath = join(outputDir, "status.json");
    const catalogPath = join(outputDir, "catalog.json");
    const sheetPath = join(outputDir, "sheet.json");
    const sheetWorkbookPath = join(outputDir, "sheet-workbook.json");
    const cachePath = join(outputDir, "anilist-cache.json");
    const entriesDir = join(outputDir, "entries");

    await Promise.all([
      access(statusPath),
      access(catalogPath),
      access(sheetPath),
      access(sheetWorkbookPath),
      access(cachePath),
      access(entriesDir),
    ]);

    const [statusText, catalogText, sheetText, workbookText, cacheText, entryFiles] = await Promise.all([
      readFile(statusPath, "utf8"),
      readFile(catalogPath, "utf8"),
      readFile(sheetPath, "utf8"),
      readFile(sheetWorkbookPath, "utf8"),
      readFile(cachePath, "utf8"),
      readdir(entriesDir),
    ]);

    const status = JSON.parse(statusText);
    JSON.parse(catalogText);
    JSON.parse(sheetText);
    JSON.parse(workbookText);
    const cachePayload = JSON.parse(cacheText);
    const expectedEntries = status?.counts?.entries;
    const actualEntryFiles = entryFiles.filter((file) => file.endsWith(".json")).length;

    if (!Number.isInteger(expectedEntries) || expectedEntries < 0) {
      console.warn(`${PROGRESS_PREFIX} Local snapshot has no valid entry count. Ignoring local output.`);
      return null;
    }
    if (actualEntryFiles !== expectedEntries) {
      console.warn(
        `${PROGRESS_PREFIX} Local snapshot entry count mismatch (${actualEntryFiles} files vs ${expectedEntries} expected). Ignoring local output.`,
      );
      return null;
    }

    if (await pathExists(join(outputDir, "manifest.json"))) {
      const manifest = await readSnapshotManifest(outputDir);
      const verification = await verifySnapshotManifest(outputDir, manifest);
      if (status?.snapshot?.id && verification.snapshotId !== status.snapshot.id) {
        throw new Error("Local snapshot manifest ID does not match status.json.");
      }
    }

    return {
      origin: "local",
      status,
      aniListCache: buildAniListCacheMap(cachePayload),
    };
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`${PROGRESS_PREFIX} Ignoring unusable local snapshot: ${error.message}`);
    }
    return null;
  }
}

async function loadRemoteStatus(statusUrl, retryLimit) {
  if (!statusUrl) {
    return null;
  }

  try {
    const manifestUrl = new URL("manifest.json", statusUrl).toString();
    const manifestResponse = await fetchWithRetry(
      manifestUrl,
      { headers: { accept: "application/json" } },
      { retries: retryLimit, label: "Remote snapshot manifest" },
    );
    const manifest = await readJsonResponse(manifestResponse, {
      maxBytes: 4 * 1024 * 1024,
      label: "Remote snapshot manifest",
    });
    validateSnapshotManifest(manifest);

    const [statusBytes, cacheBytes] = await Promise.all([
      fetchManifestedRemoteFile(statusUrl, manifest, "status.json", 2 * 1024 * 1024, retryLimit),
      fetchManifestedRemoteFile(
        new URL("anilist-cache.json", statusUrl).toString(),
        manifest,
        "anilist-cache.json",
        32 * 1024 * 1024,
        retryLimit,
      ),
    ]);
    const status = JSON.parse(statusBytes.toString("utf8"));
    const cachePayload = JSON.parse(cacheBytes.toString("utf8"));

    if (status?.snapshot?.id !== manifest.snapshotId) {
      throw new Error("Remote status snapshot ID does not match manifest.json.");
    }
    if (status?.snapshot?.sourceFingerprint !== manifest.sourceFingerprint) {
      throw new Error("Remote status source fingerprint does not match manifest.json.");
    }

    return {
      origin: "remote",
      status,
      aniListCache: buildAniListCacheMap(cachePayload),
    };
  } catch (error) {
    console.warn(`${PROGRESS_PREFIX} Could not reuse the remote snapshot cache: ${errorMessage(error)}`);
    return null;
  }
}

async function fetchManifestedRemoteFile(url, manifest, path, maxBytes, retryLimit) {
  const record = manifest.files.find((file) => file.path === path);
  if (!record) {
    throw new Error(`Remote snapshot manifest is missing ${path}.`);
  }
  if (record.bytes > maxBytes) {
    throw new Error(`Remote ${path} is ${record.bytes} bytes, above its ${maxBytes}-byte safety limit.`);
  }

  const response = await fetchWithRetry(
    url,
    { headers: { accept: "application/json", "cache-control": "no-cache" } },
    { retries: retryLimit, label: `Remote snapshot ${path}` },
  );
  const bytes = await readResponseBuffer(response, { maxBytes: record.bytes + 1, label: `Remote snapshot ${path}` });
  if (bytes.length !== record.bytes) {
    throw new Error(`Remote ${path} byte count does not match manifest.json.`);
  }
  if (sha256Buffer(bytes) !== record.sha256) {
    throw new Error(`Remote ${path} SHA-256 does not match manifest.json.`);
  }
  return bytes;
}

function buildAniListCacheMap(payload) {
  const cache = new Map();

  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const isVersionedRecord = item?.media && typeof item.media === "object";
    const media = isVersionedRecord ? item.media : item;
    const id = Number(media?.id);
    if (!Number.isInteger(id) || id <= 0) {
      continue;
    }

    // Legacy cache rows had no per-record freshness metadata. Deliberately mark them
    // stale so the first build after this migration attempts one real refresh. If
    // AniList is unavailable, fetchAniListSnapshot still retains the legacy media.
    const fetchedAt = isVersionedRecord && isValidDateString(item?.fetchedAt) ? item.fetchedAt : null;
    cache.set(id, { media, fetchedAt });
  }

  return cache;
}

function shouldSkipRebuild(existingSnapshot, nextSourceFingerprint) {
  const previousFingerprint = existingSnapshot?.status?.snapshot?.sourceFingerprint ?? null;
  return Boolean(previousFingerprint && previousFingerprint === nextSourceFingerprint);
}

function hasAniListRefreshDue(existingCache, ids, ttlHours, forceRefresh) {
  if (forceRefresh) {
    return true;
  }
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  return ids.some((id) => !isFreshCacheRecord(existingCache.get(id), cutoff));
}

function isFreshCacheRecord(record, cutoffMs) {
  const fetchedMs = Date.parse(record?.fetchedAt ?? "");
  return Boolean(record?.media && Number.isFinite(fetchedMs) && fetchedMs >= cutoffMs);
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
  const parentDir = dirname(outputDir);
  const outputName = basename(outputDir);
  const stagedDir = join(parentDir, `.${outputName}.tmp-${process.pid}-${Date.now()}`);
  const entriesDir = join(stagedDir, "entries");

  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });

  await writeJson(join(stagedDir, "status.json"), snapshot.status);
  await writeJson(join(stagedDir, "catalog.json"), snapshot.catalog);
  await writeJson(join(stagedDir, "sheet.json"), snapshot.sheet);
  await writeJson(join(stagedDir, "sheet-workbook.json"), snapshot.sheetWorkbook);
  await writeJson(join(stagedDir, "anilist-cache.json"), {
    schemaVersion: 2,
    generatedAt: snapshot.status.sync.lastRebuildFinishedAt,
    items: [...snapshot.anilistCache.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, record]) => ({
        fetchedAt: record.fetchedAt,
        media: record.media,
      })),
  });

  let written = 0;
  const total = snapshot.entries.size;
  for (const [alId, payload] of [...snapshot.entries.entries()].sort(([left], [right]) => left - right)) {
    await writeJson(join(entriesDir, `${alId}.json`), payload);
    written += 1;
    if (written % 250 === 0 || written === total) {
      logStep(`Wrote ${written}/${total} entry files...`);
    }
  }

  const manifest = await createSnapshotManifest(stagedDir, {
    snapshotId: snapshot.status.snapshot.id,
    sourceFingerprint: snapshot.status.snapshot.sourceFingerprint,
    generatedAt: snapshot.status.snapshot.createdAt,
  });
  await writeJson(join(stagedDir, "manifest.json"), manifest);
  await verifySnapshotManifest(stagedDir, manifest);
  await replaceDirectoryAtomically(stagedDir, outputDir);
  return manifest;
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
      comparisonLinks: splitLinks(entry.comparison ?? "").map((link) => sanitizeExternalUrl(link)).filter(Boolean),
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
      comparisonCount: splitLinks(entry.comparison ?? "").map((link) => sanitizeExternalUrl(link)).filter(Boolean).length,
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
        comparisonLinks: splitLinks(entry.comparison ?? "").map((link) => sanitizeExternalUrl(link)).filter(Boolean),
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
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        id: snapshot.snapshotId,
        sourceFingerprint: snapshot.sourceFingerprint,
        createdAt: snapshot.finishedAt,
        manifest: "manifest.json",
      },
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
          sourceFingerprint: snapshot.sourceFingerprint,
          snapshotId: snapshot.snapshotId,
          aniListCache: snapshot.anilistStats,
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
    sheetWorkbook: snapshot.sheetWorkbook,
    anilistCache: snapshot.anilistCache,
    entries: entryPayloads,
  };
}

async function fetchSheetWorkbookSnapshot(sheetWorkbookUrl, retryLimit) {
  const response = await fetchWithRetry(
    sheetWorkbookUrl,
    {
      headers: {
        accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream;q=0.9,*/*;q=0.8",
      },
    },
    { retries: retryLimit, timeoutMs: 30_000, label: "SeaDex workbook" },
  );
  const workbookBuffer = await readResponseBuffer(response, {
    maxBytes: MAX_WORKBOOK_BYTES,
    label: "SeaDex workbook",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer);
  const publishedRichTextLinks = await fetchPublishedSheetRichTextLinks(
    sheetWorkbookUrl,
    workbook,
    retryLimit,
  );
  const payload = serializeSheetWorkbook(workbook, publishedRichTextLinks);
  return {
    contentSha256: buildWorkbookContentFingerprint(payload),
    payload,
  };
}

function serializeSheetWorkbook(workbook, publishedRichTextLinks = new Map()) {
  const themeColors = readWorkbookThemeColors(workbook);
  const styleRegistry = new Map();
  const styles = [];
  const media = serializeWorkbookMedia(workbook);
  const credit = extractWorkbookCredit(workbook);

  return {
    generatedAt: new Date().toISOString(),
    credit,
    styles,
    media,
    sheets: workbook.worksheets.map((sheet) =>
      serializeWorkbookSheet(sheet, {
        themeColors,
        styleRegistry,
        styles,
        media,
        publishedRichTextLinks,
      }),
    ),
  };
}

function serializeWorkbookMedia(workbook) {
  return (workbook.model.media ?? [])
    .filter((item) => item?.type === "image" && item.buffer)
    .map((item, index) => ({
      id: `media-${index}`,
      mimeType: resolveWorkbookImageMimeType(item.extension),
      dataUrl: `data:${resolveWorkbookImageMimeType(item.extension)};base64,${Buffer.from(item.buffer).toString("base64")}`,
    }));
}

function serializeWorkbookSheet(sheet, context) {
  const visibleColumns = [];
  for (let columnIndex = 1; columnIndex <= sheet.columnCount; columnIndex += 1) {
    const column = sheet.getColumn(columnIndex);
    if (column.hidden) {
      continue;
    }

    visibleColumns.push({
      index: columnIndex,
      letter: columnNumberToLetter(columnIndex),
      width: sanitizeWorkbookNumber(column.width),
      hidden: false,
      outlineLevel: column.outlineLevel ?? 0,
    });
  }

  const visibleColumnIndexes = new Set(visibleColumns.map((column) => column.index));
  const rows = [];
  for (let rowIndex = 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    rows.push({
      index: rowIndex,
      height: sanitizeWorkbookNumber(row.height),
      hidden: row.hidden === true ? true : undefined,
      outlineLevel: row.outlineLevel ?? 0,
      cells: visibleColumns.map((column) =>
        serializeWorkbookCell(row.getCell(column.index), sheet.name, context),
      ),
    });
  }

  const merges = (sheet.model.merges ?? [])
    .map(parseWorkbookRange)
    .filter(Boolean)
    .map((merge) => clipVisibleMerge(merge, visibleColumnIndexes))
    .filter(Boolean);

  const images = (sheet.getImages?.() ?? [])
    .map((image) => serializeWorkbookImage(image, context.media))
    .filter(Boolean);

  return {
    id: sheet.id,
    name: sheet.name,
    slug: slugifySheetName(sheet.name),
    tabColor: resolveWorkbookColor(sheet.properties.tabColor, context.themeColors),
    rowCount: sheet.rowCount,
    columnCount: visibleColumns.length,
    defaultRowHeight: sanitizeWorkbookNumber(sheet.properties.defaultRowHeight),
    defaultColumnWidth: sanitizeWorkbookNumber(sheet.properties.defaultColWidth),
    frozenRows: Math.max(0, Math.trunc(sheet.views?.[0]?.ySplit ?? 0)),
    frozenColumns: Math.max(0, Math.trunc(sheet.views?.[0]?.xSplit ?? 0)),
    columns: visibleColumns,
    rows,
    merges,
    images,
  };
}

function serializeWorkbookCell(cell, sheetName, context) {
  const styleId = internWorkbookStyle(
    normalizeWorkbookCellStyle(cell.style ?? {}, context.themeColors),
    context.styleRegistry,
    context.styles,
  );
  const publishedCellLinks = context.publishedRichTextLinks.get(sheetName)?.get(cell.address) ?? null;
  const value = serializeWorkbookCellValue(cell, publishedCellLinks);
  const redacted = shouldRedactWorkbookCredit(sheetName, value.display);

  return {
    col: cell.col,
    address: cell.address,
    display: redacted ? "" : value.display,
    styleId,
    ...(redacted ? {} : value.richText ? { richText: value.richText } : {}),
    ...(redacted ? {} : value.hyperlink ? { hyperlink: value.hyperlink } : {}),
  };
}

function serializeWorkbookCellValue(cell, publishedCellLinks = null) {
  const value = cell.value;

  if (value === null || value === undefined) {
    return { display: "" };
  }

  if (value instanceof Date) {
    return { display: formatWorkbookDate(value) };
  }

  if (typeof value === "string") {
    return { display: value };
  }

  if (typeof value === "number") {
    return { display: Number.isFinite(value) ? String(value) : "" };
  }

  if (typeof value === "boolean") {
    return { display: value ? "TRUE" : "FALSE" };
  }

  const hyperlink = typeof value?.hyperlink === "string" ? value.hyperlink : null;
  const richText =
    Array.isArray(value?.richText)
      ? serializeWorkbookRichText(value.richText)
      : Array.isArray(value?.text?.richText)
        ? serializeWorkbookRichText(value.text.richText)
        : null;

  if (richText) {
    const linkedRichText = applyPublishedCellLinksToRichText(richText, publishedCellLinks);
    return {
      display: linkedRichText.map((entry) => entry.text).join(""),
      richText: linkedRichText,
      ...(hyperlink ? { hyperlink } : {}),
    };
  }

  if (typeof value?.text === "string") {
    return {
      display: value.text,
      ...(hyperlink ? { hyperlink } : {}),
    };
  }

  if ("result" in Object(value) && value.result !== null && value.result !== undefined) {
    if (value.result instanceof Date) {
      return { display: formatWorkbookDate(value.result) };
    }
    return { display: String(value.result) };
  }

  const fallbackText = safeWorkbookCellText(cell);
  return {
    display: fallbackText,
    ...(hyperlink ? { hyperlink } : {}),
  };
}

function safeWorkbookCellText(cell) {
  try {
    return typeof cell.text === "string" ? cell.text : "";
  } catch {
    return "";
  }
}

function serializeWorkbookRichText(richText) {
  return richText
    .map((run) => ({
      text: String(run.text ?? ""),
      ...(run.font?.bold ? { bold: true } : {}),
      ...(run.font?.italic ? { italic: true } : {}),
      ...(run.font?.underline ? { underline: true } : {}),
      ...(run.font?.strike ? { strike: true } : {}),
      ...(run.font?.name ? { fontName: run.font.name } : {}),
      ...(Number.isFinite(run.font?.size) ? { fontSize: run.font.size } : {}),
      ...(run.font?.color ? { color: resolveWorkbookColor(run.font.color, null) } : {}),
    }))
    .filter((run) => run.text.length > 0);
}

function normalizeWorkbookCellStyle(style, themeColors) {
  const font = style.font ?? {};
  const alignment = style.alignment ?? {};
  const fillColor =
    style.fill?.pattern === "solid"
      ? resolveWorkbookColor(style.fill.fgColor ?? style.fill.bgColor, themeColors)
      : null;

  return stripUndefined({
    fontName: normalizeWorkbookFontName(font.name),
    fontSize: sanitizeWorkbookNumber(font.size),
    fontWeight: font.bold ? 700 : null,
    italic: font.italic === true ? true : undefined,
    underline: font.underline ? true : undefined,
    strike: font.strike === true ? true : undefined,
    textColor: resolveWorkbookColor(font.color, themeColors),
    backgroundColor: fillColor,
    horizontalAlign: alignment.horizontal ?? null,
    verticalAlign: alignment.vertical ?? null,
    wrap: alignment.wrapText === true ? true : undefined,
    borderTop: normalizeWorkbookBorder(style.border?.top, themeColors),
    borderRight: normalizeWorkbookBorder(style.border?.right, themeColors),
    borderBottom: normalizeWorkbookBorder(style.border?.bottom, themeColors),
    borderLeft: normalizeWorkbookBorder(style.border?.left, themeColors),
  });
}

async function fetchPublishedSheetRichTextLinks(sheetWorkbookUrl, workbook, retryLimit) {
  const googleSheetId = extractGoogleSheetId(sheetWorkbookUrl);
  if (!googleSheetId) {
    return new Map();
  }

  try {
    const htmlViewUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/htmlview`;
    const response = await fetchWithRetry(htmlViewUrl, {}, {
      retries: retryLimit,
      label: "Published sheet index",
    });
    const html = await readTextResponse(response, {
      maxBytes: MAX_PUBLISHED_SHEET_HTML_BYTES,
      label: "Published sheet index",
    });
    const publishedSheets = parsePublishedSheetTabs(html);
    if (publishedSheets.length === 0) {
      return new Map();
    }

    const workbookSheetNames = new Set(workbook.worksheets.map((sheet) => sheet.name));
    const richTextLinksBySheet = new Map();

    for (const publishedSheet of publishedSheets) {
      if (!workbookSheetNames.has(publishedSheet.name)) {
        continue;
      }

      try {
        const publishedSheetUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/htmlview/sheet?headers=true&gid=${publishedSheet.gid}`;
        const publishedSheetResponse = await fetchWithRetry(publishedSheetUrl, {}, {
          retries: retryLimit,
          label: `Published sheet tab ${publishedSheet.name}`,
        });
        const publishedSheetHtml = await readTextResponse(publishedSheetResponse, {
          maxBytes: MAX_PUBLISHED_SHEET_HTML_BYTES,
          label: `Published sheet tab ${publishedSheet.name}`,
        });
        richTextLinksBySheet.set(
          publishedSheet.name,
          parsePublishedSheetCellLinks(publishedSheetHtml),
        );
      } catch (error) {
        console.warn(
          `${PROGRESS_PREFIX} Could not enrich workbook links for tab ${publishedSheet.name}: ${errorMessage(error)}`,
        );
      }
    }

    return richTextLinksBySheet;
  } catch (error) {
    console.warn(`${PROGRESS_PREFIX} Published sheet link enrichment unavailable: ${errorMessage(error)}`);
    return new Map();
  }
}

function extractGoogleSheetId(sheetWorkbookUrl) {
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(String(sheetWorkbookUrl ?? ""));
  return match?.[1] ?? null;
}

function parsePublishedSheetTabs(html) {
  const tabs = [];
  const pattern = /items\.push\(\{name:\s*"([^"]+)",[\s\S]*?gid:\s*"([^"]+)"/g;
  let match;

  while ((match = pattern.exec(html))) {
    tabs.push({
      name: decodeJsEscapes(match[1]),
      gid: decodeJsEscapes(match[2]),
    });
  }

  return tabs;
}

function parsePublishedSheetCellLinks(html) {
  const rows = new Map();
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html))) {
    const rowHtml = rowMatch[1];
    const rowNumber = extractPublishedRowNumber(rowHtml);
    if (!rowNumber) {
      continue;
    }

    const cells = new Map();
    const cellPattern = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;
    let cellMatch;
    let columnIndex = 1;

    while ((cellMatch = cellPattern.exec(rowHtml))) {
      const attributes = cellMatch[1];
      const innerHtml = cellMatch[2];
      const links = extractPublishedLinks(innerHtml);
      if (links.length > 0) {
        cells.set(columnNumberToLetter(columnIndex) + rowNumber, links);
      }

      const colspan = Number.parseInt(/colspan="(\d+)"/.exec(attributes)?.[1] ?? "1", 10);
      columnIndex += Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
    }

    if (cells.size > 0) {
      rows.set(rowNumber, cells);
    }
  }

  const linksByAddress = new Map();
  for (const cells of rows.values()) {
    for (const [address, links] of cells) {
      linksByAddress.set(address, links);
    }
  }
  return linksByAddress;
}

function extractPublishedRowNumber(rowHtml) {
  const headerMatch = rowHtml.match(/<th\b[^>]*class="row-headers-background"[^>]*>[\s\S]*?<div[^>]*>(.*?)<\/div>[\s\S]*?<\/th>/);
  if (!headerMatch) {
    return null;
  }

  const rowText = decodeHtmlEntities(stripHtmlTags(headerMatch[1])).trim();
  const rowNumber = Number.parseInt(rowText, 10);
  return Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : null;
}

function extractPublishedLinks(html) {
  const links = [];
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = pattern.exec(html))) {
    const text = decodeHtmlEntities(stripHtmlTags(match[2])).replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }

    const href = unwrapGoogleRedirectHref(decodeHtmlEntities(match[1]));
    if (!href) {
      continue;
    }

    links.push({ text, href });
  }

  return links;
}

function unwrapGoogleRedirectHref(href) {
  try {
    const url = new URL(href);
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      const target = url.searchParams.get("q");
      return target ? target : href;
    }
    return href;
  } catch {
    return href;
  }
}

function applyPublishedCellLinksToRichText(richText, publishedCellLinks) {
  if (!Array.isArray(publishedCellLinks) || publishedCellLinks.length === 0) {
    return richText;
  }

  const fullText = richText.map((run) => run.text).join("");
  const linkRanges = [];
  let searchStart = 0;

  for (const link of publishedCellLinks) {
    if (!link.text) {
      continue;
    }

    const start = fullText.indexOf(link.text, searchStart);
    if (start === -1) {
      continue;
    }

    linkRanges.push({
      start,
      end: start + link.text.length,
      href: link.href,
    });
    searchStart = start + link.text.length;
  }

  if (linkRanges.length === 0) {
    return richText;
  }

  const normalizedRuns = [];
  let globalOffset = 0;
  let activeRangeIndex = 0;

  for (const run of richText) {
    let localOffset = 0;
    while (localOffset < run.text.length) {
      const currentRange = linkRanges[activeRangeIndex] ?? null;
      const absoluteOffset = globalOffset + localOffset;

      if (!currentRange || absoluteOffset < currentRange.start) {
        const nextBoundary = currentRange ? Math.min(run.text.length, localOffset + (currentRange.start - absoluteOffset)) : run.text.length;
        normalizedRuns.push({
          ...run,
          text: run.text.slice(localOffset, nextBoundary),
        });
        localOffset = nextBoundary;
        continue;
      }

      const sliceEnd = Math.min(run.text.length, localOffset + (currentRange.end - absoluteOffset));
      normalizedRuns.push({
        ...run,
        text: run.text.slice(localOffset, sliceEnd),
        hyperlink: currentRange.href,
      });
      localOffset = sliceEnd;

      if (globalOffset + localOffset >= currentRange.end) {
        activeRangeIndex += 1;
      }
    }

    globalOffset += run.text.length;
  }

  return normalizedRuns.filter((run) => run.text.length > 0);
}

function decodeJsEscapes(value) {
  return String(value ?? "")
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function stripHtmlTags(value) {
  let str = String(value ?? "").replace(/<br\s*\/?>/gi, "\n");
  let previous;
  do {
    previous = str;
    str = str.replace(/<[^>]+>/g, "");
  } while (str !== previous);
  return str;
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function normalizeWorkbookBorder(border, themeColors) {
  if (!border?.style) {
    return null;
  }

  return stripUndefined({
    style: border.style,
    color: resolveWorkbookColor(border.color, themeColors),
  });
}

function internWorkbookStyle(style, registry, styles) {
  const key = JSON.stringify(style);
  const existing = registry.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const nextId = styles.length;
  registry.set(key, nextId);
  styles.push(style);
  return nextId;
}

function serializeWorkbookImage(image, media) {
  const mediaItem = media[image.imageId];
  if (!mediaItem || !image.range?.tl || !image.range?.ext) {
    return null;
  }

  return {
    mediaId: mediaItem.id,
    col: image.range.tl.nativeCol + 1,
    row: image.range.tl.nativeRow + 1,
    offsetX: image.range.tl.nativeColOff ?? 0,
    offsetY: image.range.tl.nativeRowOff ?? 0,
    width: image.range.ext.width,
    height: image.range.ext.height,
  };
}

function extractWorkbookCredit(workbook) {
  for (const sheetName of ["TV", "Movies"]) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      continue;
    }

    const searchLimit = Math.min(sheet.columnCount, 8);
    for (let columnIndex = 1; columnIndex <= searchLimit; columnIndex += 1) {
      const cell = sheet.getRow(1).getCell(columnIndex);
      const display = serializeWorkbookCellValue(cell).display;
      if (!display.includes("Made by SeaSmoke")) {
        continue;
      }

      const hyperlink = typeof cell.value?.hyperlink === "string" ? cell.value.hyperlink : null;
      return {
        label: "Original sheet by SeaSmoke#0002",
        ...(hyperlink ? { url: hyperlink } : {}),
      };
    }
  }

  return null;
}

function shouldRedactWorkbookCredit(sheetName, display) {
  return (sheetName === "TV" || sheetName === "Movies") && display.includes("Made by SeaSmoke");
}

function clipVisibleMerge(merge, visibleColumnIndexes) {
  if (!merge) {
    return null;
  }

  const visibleColumns = [];
  for (let columnIndex = merge.startCol; columnIndex <= merge.endCol; columnIndex += 1) {
    if (visibleColumnIndexes.has(columnIndex)) {
      visibleColumns.push(columnIndex);
    }
  }

  if (visibleColumns.length === 0) {
    return null;
  }

  return {
    startRow: merge.startRow,
    endRow: merge.endRow,
    startCol: visibleColumns[0],
    endCol: visibleColumns[visibleColumns.length - 1],
  };
}

function parseWorkbookRange(rangeText) {
  if (!rangeText || typeof rangeText !== "string") {
    return null;
  }

  const [left, right = left] = rangeText.split(":");
  const start = decodeWorkbookAddress(left);
  const end = decodeWorkbookAddress(right);
  if (!start || !end) {
    return null;
  }

  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endCol: Math.max(start.col, end.col),
  };
}

function decodeWorkbookAddress(address) {
  const match = String(address).match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    col: letterToColumnNumber(match[1].toUpperCase()),
    row: Number.parseInt(match[2], 10),
  };
}

function columnNumberToLetter(value) {
  let column = value;
  let label = "";
  while (column > 0) {
    const remainder = (column - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    column = Math.floor((column - 1) / 26);
  }
  return label;
}

function letterToColumnNumber(value) {
  let total = 0;
  for (const character of value) {
    total = total * 26 + (character.charCodeAt(0) - 64);
  }
  return total;
}

function slugifySheetName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sheet";
}

function readWorkbookThemeColors(workbook) {
  const themeXml = workbook._themes?.theme1 ?? "";
  const slots = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const fallbacks = ["#ffffff", "#000000", "#ffffff", "#000000", "#ffe89a", "#ff9494", "#d37abc", "#93d2fd", "#639aff", "#4cdc8b", "#0097a7", "#0097a7"];

  return slots.map((slot, index) => readThemeSlotColor(themeXml, slot) ?? fallbacks[index]);
}

function readThemeSlotColor(themeXml, slot) {
  if (!themeXml) {
    return null;
  }

  const direct = themeXml.match(new RegExp(`<a:${slot}>\\s*<a:srgbClr val="([0-9A-F]{6,8})"`, "i"));
  if (direct?.[1]) {
    return normalizeWorkbookArgb(direct[1]);
  }

  const sys = themeXml.match(new RegExp(`<a:${slot}>\\s*<a:sysClr[^>]*lastClr="([0-9A-F]{6,8})"`, "i"));
  if (sys?.[1]) {
    return normalizeWorkbookArgb(sys[1]);
  }

  return null;
}

function resolveWorkbookColor(color, themeColors) {
  if (!color) {
    return null;
  }

  if (color.argb) {
    return normalizeWorkbookArgb(color.argb);
  }

  if (typeof color.theme === "number") {
    return themeColors?.[color.theme] ?? null;
  }

  return null;
}

function normalizeWorkbookArgb(value) {
  const input = String(value).trim();
  if (!input) {
    return null;
  }

  const hex = input.length === 8 ? input.slice(2) : input;
  return `#${hex.toLowerCase()}`;
}

function normalizeWorkbookFontName(name) {
  if (!name || name === "Inherit") {
    return null;
  }
  if (name === "Docs-Roboto") {
    return "Roboto";
  }
  return name;
}

function resolveWorkbookImageMimeType(extension) {
  switch (String(extension ?? "").toLowerCase()) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function sanitizeWorkbookNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripUndefined(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== false),
  );
}

function formatWorkbookDate(value) {
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const year = String(value.getUTCFullYear());
  return `${day}/${month}/${year}`;
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

async function fetchAniListSnapshot(
  endpoint,
  ids,
  batchSize,
  delayMs,
  retryLimit,
  accessToken,
  existingCache,
  refreshAniList,
  cacheTtlHours,
) {
  const media = new Map();
  // Rebuild the cache from the active SeaDex ID set so records for removed entries
  // cannot accumulate forever. Fresh/stale records are copied below as they are used.
  const cache = new Map();
  const refreshIds = [];
  const cutoff = Date.now() - cacheTtlHours * 60 * 60 * 1000;
  const stats = {
    reusedFresh: 0,
    fetched: 0,
    staleFallback: 0,
    unresolved: 0,
    ttlHours: cacheTtlHours,
  };

  for (const id of ids) {
    const cached = existingCache.get(id) ?? null;
    if (!refreshAniList && isFreshCacheRecord(cached, cutoff)) {
      media.set(id, cached.media);
      cache.set(id, cached);
      stats.reusedFresh += 1;
    } else {
      refreshIds.push(id);
    }
  }

  if (stats.reusedFresh > 0) {
    logStep(`Reused fresh AniList metadata for ${stats.reusedFresh}/${ids.length} entries.`);
  }
  if (refreshAniList) {
    logStep(`Explicit AniList cache refresh requested for ${refreshIds.length} entries.`);
  } else if (refreshIds.length > 0) {
    logStep(`Refreshing ${refreshIds.length} missing or expired AniList cache record(s).`);
  }

  const batches = chunk(refreshIds, batchSize);
  for (const [index, batch] of batches.entries()) {
    let payload = null;
    let requestError = null;
    logStep(`AniList batch ${index + 1}/${batches.length} starting (${batch.length} ids).`);

    try {
      payload = await fetchAniListBatch(endpoint, batch, accessToken, retryLimit);
    } catch (error) {
      requestError = error;
      if (accessToken) {
        console.warn(
          `${PROGRESS_PREFIX} AniList authenticated request failed for batch ${index + 1}/${batches.length}; retrying in public mode.`,
        );
        try {
          payload = await fetchAniListBatch(endpoint, batch, "", retryLimit);
        } catch (publicError) {
          requestError = publicError;
        }
      }
    }

    const returnedById = new Map(
      Array.isArray(payload)
        ? payload
            .filter((item) => Number.isInteger(item?.id) && item.id > 0)
            .map((item) => [item.id, item])
        : [],
    );
    const fetchedAt = new Date().toISOString();
    let batchFallbacks = 0;
    let batchUnresolved = 0;

    for (const id of batch) {
      const fetchedMedia = returnedById.get(id) ?? null;
      if (fetchedMedia) {
        media.set(id, fetchedMedia);
        cache.set(id, { media: fetchedMedia, fetchedAt });
        stats.fetched += 1;
        continue;
      }

      const cached = existingCache.get(id) ?? null;
      if (cached?.media) {
        media.set(id, cached.media);
        cache.set(id, cached);
        stats.staleFallback += 1;
        batchFallbacks += 1;
        continue;
      }

      stats.unresolved += 1;
      batchUnresolved += 1;
    }

    if (!payload && requestError) {
      console.warn(
        `${PROGRESS_PREFIX} AniList batch ${index + 1}/${batches.length} unavailable; retained ${batchFallbacks} cached record(s), with ${batchUnresolved} unresolved: ${errorMessage(requestError)}`,
      );
    }

    logStep(
      `AniList batch ${index + 1}/${batches.length} finished (${returnedById.size} fetched, ${media.size} total resolved).`,
    );

    if (index < batches.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (stats.unresolved > 0) {
    console.warn(
      `${PROGRESS_PREFIX} AniList enrichment is unavailable for ${stats.unresolved} entry/entries. SeaDex source data will still be preserved.`,
    );
  }

  return { media, cache, stats };
}

async function fetchAniListBatch(endpoint, ids, accessToken, retryLimit) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: ANILIST_MEDIA_QUERY,
        variables: { ids, page: 1, perPage: ids.length },
      }),
    },
    { retries: retryLimit, label: "AniList GraphQL" },
  );
  const payload = await readJsonResponse(response, {
    maxBytes: 16 * 1024 * 1024,
    label: "AniList GraphQL",
  });
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message ?? "Unknown AniList error").join("; "));
  }
  return Array.isArray(payload.data?.Page?.media) ? payload.data.Page.media : [];
}

function resolveSourceUrl(sourceBaseUrl, value) {
  return sanitizeExternalUrl(value, sourceBaseUrl, new Set(["https:", "http:", "magnet:"])) ?? "";
}

function requireHttpUrl(value, label) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    return url.toString().replace(/\/+$/u, "");
  } catch (error) {
    throw new Error(`${label} is invalid: ${errorMessage(error)}`, { cause: error });
  }
}

function sanitizeExternalUrl(value, baseUrl = undefined, allowedProtocols = new Set(["https:", "http:"])) {
  if (!value) {
    return null;
  }

  try {
    const url = baseUrl ? new URL(String(value), baseUrl) : new URL(String(value));
    return allowedProtocols.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
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

function isValidDateString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "unknown size";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let current = value / 1024;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unitIndex]}`;
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

function resolveOnUnchangedBehavior(args) {
  const rawValue =
    args.onUnchanged ?? (args.materializeOnSkip === "true" ? "materialize" : DEFAULT_ON_UNCHANGED);

  switch (rawValue) {
    case "skip":
    case "materialize":
      return rawValue;
    default:
      throw new Error(`Invalid --onUnchanged value "${rawValue}". Expected "skip" or "materialize".`);
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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
  if (error instanceof HttpRequestError && error.url) {
    console.error(`${PROGRESS_PREFIX} Failing request: ${error.url}`);
  }
  console.error(`${PROGRESS_PREFIX} Snapshot build aborted; any previous mirror data was left untouched.`);
  process.exitCode = 1;
});
