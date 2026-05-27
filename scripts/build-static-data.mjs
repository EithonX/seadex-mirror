import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import ExcelJS from "exceljs";

const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
const DEFAULT_ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const DEFAULT_SHEET_WORKBOOK_URL =
  "https://docs.google.com/spreadsheets/d/1emW2Zsb0gEtEHiub_YHpazvBd4lL4saxCwyPhbtxXYM/export?format=xlsx";
const DEFAULT_SOURCE_PAGE_SIZE = 100;
const DEFAULT_SOURCE_PROBE_SIZE = 8;
const DEFAULT_ANILIST_BATCH_SIZE = 50;
const DEFAULT_ANILIST_DELAY_MS = 2200;
const DEFAULT_RETRY_LIMIT = 5;
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
  const sheetWorkbookUrl =
    args.sheetWorkbookUrl ?? process.env.SHEET_WORKBOOK_URL ?? DEFAULT_SHEET_WORKBOOK_URL;
  const outputDir = resolve(args.out ?? DEFAULT_OUTPUT_DIR);
  const reportPath = args.report ? resolve(args.report) : "";
  const force = args.force === "true";
  const refreshAniList = args.refreshAniList === "true";
  const onUnchanged = resolveOnUnchangedBehavior(args);

  warnAniListCredentialMode(anilistAccessToken, anilistClientId, anilistClientSecret);
  logStep(`Starting snapshot build${force ? " (forced)" : ""}.`);

  const startedAt = new Date().toISOString();
  const localSnapshot = await loadLocalSnapshot(outputDir);
  const remoteSnapshot = localSnapshot ? null : await loadRemoteStatus(statusUrl);
  const existingSnapshot = localSnapshot ?? remoteSnapshot;
  logStep("Fetching SeaDex list IDs...");
  const listIds = await fetchListIds(sourceBaseUrl);
  logStep(`Fetched ${listIds.length} list IDs.`);
  logStep(`Fetching upstream probe (${probeSize} recent rows)...`);
  const sourceProbe = await fetchSourceProbe(sourceBaseUrl, probeSize);
  const probeSignature = buildProbeSignature(listIds, sourceProbe.items);
  logStep(`Computed upstream probe signature from ${sourceProbe.items.length} rows.`);

  const upstreamUnchanged = !force && shouldSkipRebuild(existingSnapshot, probeSignature);
  const shouldMaterializeSnapshot = upstreamUnchanged && onUnchanged === "materialize" && !localSnapshot;

  if (upstreamUnchanged && !shouldMaterializeSnapshot) {
    const report = {
      action: "skipped",
      mode: "static-snapshot",
      skipped: true,
      reason: "upstream-unchanged",
      sourceBaseUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      probeSignature,
      snapshotSource: existingSnapshot?.origin ?? null,
      localSnapshotReady: Boolean(localSnapshot),
      onUnchanged,
      entries: existingSnapshot?.status?.counts?.entries ?? null,
      torrents: existingSnapshot?.status?.counts?.torrents ?? null,
    };
    await writeOptionalReport(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (shouldMaterializeSnapshot) {
    logStep(
      `Upstream is unchanged, but local mirror data is unavailable. Materializing a local snapshot using the ${existingSnapshot?.origin ?? "available"} cache.`,
    );
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

  logStep("Fetching published SeaDex sheet workbook...");
  const sheetWorkbook = await fetchSheetWorkbookSnapshot(sheetWorkbookUrl);
  logStep(`Workbook snapshot ready with ${sheetWorkbook.sheets.length} tab(s).`);

  const finishedAt = new Date().toISOString();
  logStep("Composing static snapshot payloads...");
  const snapshot = buildStaticSnapshot({
    sourceBaseUrl,
    startedAt,
    finishedAt,
    listIds,
    entries: sourceSnapshot.entries,
    anilistMedia,
    sheetWorkbook,
    sourceProbe,
    probeSignature,
  });

  logStep(`Writing snapshot files to ${outputDir}...`);
  await writeSnapshot(outputDir, snapshot);
  logStep("Snapshot files written successfully.");

  const report = {
    action: shouldMaterializeSnapshot ? "materialized" : "rebuilt",
    mode: "static-snapshot",
    skipped: false,
    sourceBaseUrl,
    startedAt,
    finishedAt,
    outputDir,
    snapshotSource: existingSnapshot?.origin ?? null,
    localSnapshotReady: true,
    onUnchanged,
    entries: snapshot.catalog.items.length,
    entryFiles: snapshot.catalog.items.length,
    torrents: snapshot.status.counts.torrents,
    anilistMedia: snapshot.status.counts.anilistMedia,
    sheetTabs: snapshot.sheetWorkbook.sheets.length,
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

    await access(statusPath);
    await access(catalogPath);
    await access(sheetPath);
    await access(sheetWorkbookPath);
    await access(cachePath);
    await access(entriesDir);

    const [statusText, _catalogText, _sheetText, workbookText, cacheText, entryFiles] = await Promise.all([
      readFile(statusPath, "utf8"),
      readFile(catalogPath, "utf8"),
      readFile(sheetPath, "utf8"),
      readFile(sheetWorkbookPath, "utf8"),
      readFile(cachePath, "utf8"),
      readdir(entriesDir),
    ]);

    const status = JSON.parse(statusText);
    JSON.parse(_catalogText);
    JSON.parse(_sheetText);
    JSON.parse(workbookText);
    const cachePayload = JSON.parse(cacheText);
    const expectedEntries = status?.counts?.entries;
    const actualEntryFiles = entryFiles.filter((file) => file.endsWith(".json")).length;

    if (!Number.isInteger(expectedEntries) || expectedEntries < 0) {
      console.warn(`${PROGRESS_PREFIX} Local snapshot is missing a valid entry count in status.json. Ignoring local output.`);
      return null;
    }

    if (actualEntryFiles !== expectedEntries) {
      console.warn(
        `${PROGRESS_PREFIX} Local snapshot entry count mismatch (${actualEntryFiles} files vs ${expectedEntries} expected). Ignoring local output.`,
      );
      return null;
    }

    return {
      origin: "local",
      status,
      aniListCache: buildAniListCacheMap(cachePayload),
    };
  } catch {
    return null;
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
      origin: "remote",
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
  const parentDir = dirname(outputDir);
  const outputName = basename(outputDir);
  const stagedDir = join(parentDir, `.${outputName}.tmp-${process.pid}-${Date.now()}`);
  const backupDir = join(parentDir, `.${outputName}.bak-${process.pid}-${Date.now()}`);
  const entriesDir = join(stagedDir, "entries");

  await rm(stagedDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });

  await writeJson(join(stagedDir, "status.json"), snapshot.status);
  await writeJson(join(stagedDir, "catalog.json"), snapshot.catalog);
  await writeJson(join(stagedDir, "sheet.json"), snapshot.sheet);
  await writeJson(join(stagedDir, "sheet-workbook.json"), snapshot.sheetWorkbook);
  await writeJson(join(stagedDir, "anilist-cache.json"), {
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

  let backupCreated = false;

  try {
    if (await pathExists(outputDir)) {
      await rename(outputDir, backupDir);
      backupCreated = true;
    }

    await rename(stagedDir, outputDir);

    if (backupCreated) {
      await rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(stagedDir, { recursive: true, force: true });

    if (!(await pathExists(outputDir)) && backupCreated && (await pathExists(backupDir))) {
      try {
        await rename(backupDir, outputDir);
      } catch {
        console.warn(`${PROGRESS_PREFIX} Failed to restore the previous snapshot after a write error.`);
      }
    }

    throw error;
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
    sheetWorkbook: snapshot.sheetWorkbook,
    anilistCache: snapshot.anilistMedia,
    entries: entryPayloads,
  };
}

async function fetchSheetWorkbookSnapshot(sheetWorkbookUrl) {
  const response = await fetch(sheetWorkbookUrl, {
    headers: {
      accept:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Sheet workbook request failed with ${response.status} ${response.statusText}.`);
  }

  const workbookBuffer = Buffer.from(await response.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer);
  const publishedRichTextLinks = await fetchPublishedSheetRichTextLinks(sheetWorkbookUrl, workbook);
  return serializeSheetWorkbook(workbook, publishedRichTextLinks);
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

async function fetchPublishedSheetRichTextLinks(sheetWorkbookUrl, workbook) {
  const googleSheetId = extractGoogleSheetId(sheetWorkbookUrl);
  if (!googleSheetId) {
    return new Map();
  }

  try {
    const htmlViewUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/htmlview`;
    const response = await fetch(htmlViewUrl);
    if (!response.ok) {
      return new Map();
    }

    const html = await response.text();
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

      const publishedSheetUrl = `https://docs.google.com/spreadsheets/d/${googleSheetId}/htmlview/sheet?headers=true&gid=${publishedSheet.gid}`;
      const publishedSheetResponse = await fetch(publishedSheetUrl);
      if (!publishedSheetResponse.ok) {
        continue;
      }

      const publishedSheetHtml = await publishedSheetResponse.text();
      richTextLinksBySheet.set(publishedSheet.name, parsePublishedSheetCellLinks(publishedSheetHtml));
    }

    return richTextLinksBySheet;
  } catch {
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
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
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

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
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
