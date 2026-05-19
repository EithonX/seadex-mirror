import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_SOURCE_BASE_URL = "https://releases.moe";
const DEFAULT_ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
const DEFAULT_D1_DATABASE_NAME = "seadex_mirror";
const DEFAULT_SOURCE_PAGE_SIZE = 100;
const DEFAULT_ANILIST_BATCH_SIZE = 25;
const DEFAULT_ANILIST_DELAY_MS = 800;
const DEFAULT_OUTPUT_PATH = "tmp/rebuild-d1.sql";
const DEFAULT_RETRY_LIMIT = 5;

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
  const databaseName = args.db ?? process.env.D1_DATABASE_NAME ?? DEFAULT_D1_DATABASE_NAME;
  const pageSize = parsePositiveInt(args.pageSize, DEFAULT_SOURCE_PAGE_SIZE);
  const anilistBatchSize = parsePositiveInt(args.batchSize, DEFAULT_ANILIST_BATCH_SIZE);
  const anilistDelayMs = parsePositiveInt(args.delayMs, DEFAULT_ANILIST_DELAY_MS);
  const retryLimit = parsePositiveInt(args.retryLimit, DEFAULT_RETRY_LIMIT);
  const outputPath = resolve(args.out ?? DEFAULT_OUTPUT_PATH);
  const apply = args.apply === "true";

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
  const sql = buildSqlSnapshot({
    sourceBaseUrl,
    startedAt,
    finishedAt,
    listIds,
    entries: sourceSnapshot.entries,
    anilistMedia,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, sql, "utf8");

  console.log(
    JSON.stringify(
      {
        sourceBaseUrl,
        startedAt,
        finishedAt,
        listIds: listIds.length,
        entries: sourceSnapshot.entries.length,
        torrents: sourceSnapshot.torrentCount,
        anilistMedia: anilistMedia.size,
        outputPath,
      },
      null,
      2,
    ),
  );

  if (apply) {
    runWranglerImport(databaseName, outputPath);
  }
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
  let torrentCount = 0;
  for (const entry of entries) {
    if (seen.has(entry.alID)) {
      continue;
    }
    seen.add(entry.alID);
    deduped.push(entry);
    torrentCount += entry.expand?.trs?.length ?? 0;
  }

  return {
    entries: deduped,
    torrentCount,
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

    console.log(
      `Fetched AniList batch ${index + 1}/${batches.length} for ids ${batch[0]}-${batch[batch.length - 1]}.`,
    );

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

function buildSqlSnapshot(snapshot) {
  const mirroredAt = snapshot.finishedAt;
  const summary = {
    mode: "external-full-rebuild",
    sourceBaseUrl: snapshot.sourceBaseUrl,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    entries: snapshot.entries.length,
    torrents: snapshot.entries.reduce((sum, entry) => sum + (entry.expand?.trs?.length ?? 0), 0),
    anilistMedia: snapshot.anilistMedia.size,
  };

  const lines = [
    "DELETE FROM torrents;",
    "DELETE FROM entries;",
    "DELETE FROM anilist_media;",
    "DELETE FROM sync_state;",
  ];

  for (const entry of snapshot.entries) {
    const torrents = entry.expand?.trs ?? [];
    const bestTorrentCount = torrents.filter((torrent) => torrent.isBest === true).length;

    lines.push(
      `INSERT INTO entries (
        al_id,
        record_id,
        comparison,
        notes,
        theoretical_best,
        incomplete,
        source_created_at,
        source_updated_at,
        mirrored_at,
        torrent_count,
        best_torrent_count
      ) VALUES (
        ${sqlNumber(entry.alID)},
        ${sqlString(entry.id)},
        ${sqlString(entry.comparison ?? "")},
        ${sqlString(entry.notes ?? "")},
        ${sqlString(entry.theoreticalBest ?? "")},
        ${sqlBoolean(entry.incomplete)},
        ${sqlString(entry.created)},
        ${sqlString(entry.updated)},
        ${sqlString(mirroredAt)},
        ${sqlNumber(torrents.length)},
        ${sqlNumber(bestTorrentCount)}
      );`,
    );

    for (const torrent of torrents) {
      lines.push(
        `INSERT INTO torrents (
          mirror_key,
          source_torrent_id,
          entry_al_id,
          release_group,
          tracker,
          source_url,
          resolved_url,
          source_grouped_url,
          resolved_grouped_url,
          info_hash,
          dual_audio,
          is_best,
          tags_json,
        files_json,
        source_created_at,
        source_updated_at,
        mirrored_at
      ) VALUES (
          ${sqlString(`${entry.alID}:${torrent.id}`)},
          ${sqlString(torrent.id)},
          ${sqlNumber(entry.alID)},
          ${sqlString(torrent.releaseGroup ?? "")},
          ${sqlString(torrent.tracker ?? "")},
          ${sqlString(torrent.url ?? "")},
          ${sqlString(resolveSourceUrl(snapshot.sourceBaseUrl, torrent.url ?? ""))},
          ${sqlString(torrent.groupedUrl ?? "")},
          ${sqlString(resolveSourceUrl(snapshot.sourceBaseUrl, torrent.groupedUrl ?? ""))},
          ${sqlString(torrent.infoHash ?? "")},
          ${sqlBoolean(torrent.dualAudio)},
          ${sqlBoolean(torrent.isBest)},
          ${sqlString(JSON.stringify(torrent.tags ?? []))},
          ${sqlString(JSON.stringify(torrent.files ?? []))},
          ${sqlString(torrent.created)},
          ${sqlString(torrent.updated)},
          ${sqlString(mirroredAt)}
        );`,
      );
    }
  }

  for (const media of snapshot.anilistMedia.values()) {
    lines.push(
      `INSERT INTO anilist_media (
        id,
        title_user_preferred,
        title_english,
        cover_image_extra_large,
        cover_image_color,
        season,
        season_year,
        start_year,
        format,
        status,
        episodes,
        duration,
        average_score,
        genres_json,
        relations_json,
        fetched_at
      ) VALUES (
        ${sqlNumber(media.id)},
        ${sqlString(media.title?.userPreferred ?? "")},
        ${sqlString(media.title?.english ?? "")},
        ${sqlString(media.coverImage?.extraLarge ?? "")},
        ${sqlString(media.coverImage?.color ?? "")},
        ${sqlString(media.season ?? "")},
        ${sqlNullableNumber(media.seasonYear)},
        ${sqlNullableNumber(media.startDate?.year)},
        ${sqlString(media.format ?? "")},
        ${sqlString(media.status ?? "")},
        ${sqlNullableNumber(media.episodes)},
        ${sqlNullableNumber(media.duration)},
        ${sqlNullableNumber(media.averageScore)},
        ${sqlString(JSON.stringify(media.genres ?? []))},
        ${sqlString(JSON.stringify(media.relations?.edges ?? []))},
        ${sqlString(mirroredAt)}
      );`,
    );
  }

  lines.push(
    syncStateInsert("source_list_id_count", String(snapshot.listIds.length), mirroredAt),
    syncStateInsert("source_entry_count", String(snapshot.entries.length), mirroredAt),
    syncStateInsert(
      "source_torrent_count",
      String(snapshot.entries.reduce((sum, entry) => sum + (entry.expand?.trs?.length ?? 0), 0)),
      mirroredAt,
    ),
    syncStateInsert("anilist_media_count", String(snapshot.anilistMedia.size), mirroredAt),
    syncStateInsert("source_list_id_parity", "match", mirroredAt),
    syncStateInsert("expanded_torrent_parity", "match", mirroredAt),
    syncStateInsert("last_rebuild_mode", "external-full-rebuild", mirroredAt),
    syncStateInsert("last_rebuild_started_at", snapshot.startedAt, mirroredAt),
    syncStateInsert("last_rebuild_finished_at", snapshot.finishedAt, mirroredAt),
    syncStateInsert("last_error", "", mirroredAt),
    syncStateInsert("last_rebuild_summary", JSON.stringify(summary), mirroredAt),
  );

  return `${lines.join("\n")}\n`;
}

function syncStateInsert(key, value, updatedAt) {
  return `INSERT INTO sync_state (key, value, updated_at) VALUES (${sqlString(key)}, ${sqlString(value)}, ${sqlString(updatedAt)});`;
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

function runWranglerImport(databaseName, filePath) {
  const wranglerExecutable =
    process.platform === "win32"
      ? resolve("node_modules", ".bin", "wrangler.cmd")
      : resolve("node_modules", ".bin", "wrangler");

  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", wranglerExecutable, "d1", "execute", databaseName, "--remote", "--file", filePath], {
      stdio: "inherit",
    });
    return;
  }

  execFileSync(wranglerExecutable, ["d1", "execute", databaseName, "--remote", "--file", filePath], {
    stdio: "inherit",
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

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

function sqlNullableNumber(value) {
  return Number.isFinite(value) ? String(value) : "NULL";
}

function sqlBoolean(value) {
  return value ? "1" : "0";
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
