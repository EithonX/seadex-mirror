import { DEFAULT_CACHE_TTL_SECONDS, DEFAULT_SOURCE_BASE_URL, type RuntimeEnv } from "./types";

type CatalogRow = {
  al_id: number;
  record_id: string;
  comparison: string;
  notes: string;
  incomplete: number;
  source_updated_at: string;
  torrent_count: number;
  best_torrent_count: number;
  title_user_preferred: string;
  title_english: string;
  cover_image_extra_large: string;
  cover_image_color: string;
  season: string;
  season_year: number | null;
  start_year: number | null;
  format: string;
  status: string;
  episodes: number | null;
  average_score: number | null;
};

type EntryRow = {
  al_id: number;
  record_id: string;
  comparison: string;
  notes: string;
  theoretical_best: string;
  incomplete: number;
  source_created_at: string;
  source_updated_at: string;
  torrent_count: number;
  best_torrent_count: number;
  title_user_preferred: string;
  title_english: string;
  cover_image_extra_large: string;
  cover_image_color: string;
  season: string;
  season_year: number | null;
  start_year: number | null;
  format: string;
  status: string;
  episodes: number | null;
  duration: number | null;
  average_score: number | null;
  genres_json: string;
  relations_json: string;
};

type TorrentRow = {
  source_torrent_id: string;
  release_group: string;
  tracker: string;
  source_url: string;
  resolved_url: string;
  source_grouped_url: string;
  resolved_grouped_url: string;
  info_hash: string;
  dual_audio: number;
  is_best: number;
  tags_json: string;
  files_json: string;
  source_updated_at: string;
};

type SyncStateRow = {
  key: string;
  value: string;
  updated_at: string;
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function handleRequest(
  request: Request,
  env: RuntimeEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/api/")) {
    return json(
      {
        error: "This Worker only handles /api routes. Static assets are served through Cloudflare assets.",
      },
      env,
      404,
      false,
    );
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/v1/status") {
      return json(await getStatusPayload(env), env, 200, false);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/catalog") {
      return withJsonCache(env, ctx, cacheKeyFromRequest("catalog", url), async () => {
        return getCatalogPayload(env, url);
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/v1/entries/")) {
      const alId = parseEntryId(url.pathname);
      if (alId === null) {
        return json({ error: "Invalid AniList id." }, env, 400, false);
      }

      return withJsonCache(env, ctx, cacheKeyFromRequest(`entry:${alId}`, url), async () => {
        return getEntryPayload(env, alId);
      });
    }

    return json({ error: "Route not found." }, env, 404, false);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "api_request_failed",
        path: url.pathname,
        error: toErrorMessage(error),
      }),
    );
    return json({ error: toErrorMessage(error) }, env, 500, false);
  }
}

async function withJsonCache<T>(
  env: RuntimeEnv,
  ctx: ExecutionContext,
  logicalKey: string,
  loader: () => Promise<T>,
): Promise<Response> {
  const cache = await caches.open("seadex-api");
  const cacheRequest = new Request(`https://cache.internal/${logicalKey}`);
  const cached = await cache.match(cacheRequest);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-mirror-cache", "hit");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const body = JSON.stringify(await loader());
  const response = new Response(body, {
    headers: jsonHeaders(env, true, {
      "x-mirror-cache": "miss",
    }),
  });
  ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  return response;
}

async function getStatusPayload(env: RuntimeEnv): Promise<Record<string, unknown>> {
  const [stateRows, entryCount, torrentCount, mediaCount, missingMediaCount, zeroTorrentCount] = await Promise.all([
    env.DB.prepare("SELECT key, value, updated_at FROM sync_state ORDER BY key").all<SyncStateRow>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM entries").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM torrents").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM anilist_media").first<{ count: number }>(),
    env.DB
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM entries e
          LEFT JOIN anilist_media a ON a.id = e.al_id
          WHERE a.id IS NULL
        `,
      )
      .first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM entries WHERE torrent_count = 0").first<{ count: number }>(),
  ]);

  const stateMap = new Map<string, SyncStateRow>();
  for (const row of stateRows.results ?? []) {
    stateMap.set(row.key, row);
  }

  const summary = safeJsonParse<Record<string, unknown> | null>(
    stateMap.get("last_rebuild_summary")?.value ?? "",
    null,
  );

  return {
    mirror: {
      sourceBaseUrl: env.SOURCE_BASE_URL ?? DEFAULT_SOURCE_BASE_URL,
      originalSite: "releases.moe",
      attribution: "SeaDex data originates from releases.moe. AniList metadata is cached by this mirror.",
      disclaimer: "This is an unofficial community mirror built to stay readable when the upstream frontend or AniList path is unstable.",
    },
    counts: {
      entries: Number(entryCount?.count ?? 0),
      torrents: Number(torrentCount?.count ?? 0),
      anilistMedia: Number(mediaCount?.count ?? 0),
    },
    integrity: {
      entriesWithoutTorrents: Number(zeroTorrentCount?.count ?? 0),
      entriesWithoutAniList: Number(missingMediaCount?.count ?? 0),
      sourceListIdCount: Number(stateMap.get("source_list_id_count")?.value ?? 0),
      sourceEntryCount: Number(stateMap.get("source_entry_count")?.value ?? 0),
      sourceTorrentCount: Number(stateMap.get("source_torrent_count")?.value ?? 0),
      listIdParity: stateMap.get("source_list_id_parity")?.value ?? null,
      expandedTorrentParity: stateMap.get("expanded_torrent_parity")?.value ?? null,
    },
    sync: {
      lastRebuildStartedAt: stateMap.get("last_rebuild_started_at")?.value ?? null,
      lastRebuildFinishedAt: stateMap.get("last_rebuild_finished_at")?.value ?? null,
      lastRebuildMode: stateMap.get("last_rebuild_mode")?.value ?? null,
      lastError: stateMap.get("last_error")?.value || null,
      summary,
    },
  };
}

async function getCatalogPayload(env: RuntimeEnv, url: URL): Promise<Record<string, unknown>> {
  const search = (url.searchParams.get("search") ?? "").trim();
  const format = (url.searchParams.get("format") ?? "").trim().toUpperCase();
  const sort = (url.searchParams.get("sort") ?? "updated").trim();
  const limit = clampInt(url.searchParams.get("limit"), 24, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 5000);

  let sql = `
    SELECT
      e.al_id,
      e.record_id,
      e.comparison,
      e.notes,
      e.incomplete,
      e.source_updated_at,
      e.torrent_count,
      e.best_torrent_count,
      COALESCE(a.title_user_preferred, '') AS title_user_preferred,
      COALESCE(a.title_english, '') AS title_english,
      COALESCE(a.cover_image_extra_large, '') AS cover_image_extra_large,
      COALESCE(a.cover_image_color, '') AS cover_image_color,
      COALESCE(a.season, '') AS season,
      a.season_year,
      a.start_year,
      COALESCE(a.format, '') AS format,
      COALESCE(a.status, '') AS status,
      a.episodes,
      a.average_score
    FROM entries e
    LEFT JOIN anilist_media a ON a.id = e.al_id
    WHERE 1 = 1
  `;

  const binds: Array<string | number> = [];
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    sql += `
      AND (
        lower(COALESCE(a.title_user_preferred, '')) LIKE ?
        OR lower(COALESCE(a.title_english, '')) LIKE ?
        OR lower(COALESCE(e.notes, '')) LIKE ?
        OR CAST(e.al_id AS TEXT) = ?
      )
    `;
    binds.push(like, like, like, search);
  }

  if (format) {
    sql += " AND upper(COALESCE(a.format, '')) = ? ";
    binds.push(format);
  }

  switch (sort) {
    case "title":
      sql += " ORDER BY lower(COALESCE(NULLIF(a.title_english, ''), NULLIF(a.title_user_preferred, ''), CAST(e.al_id AS TEXT))) ASC ";
      break;
    case "year":
      sql += " ORDER BY COALESCE(a.start_year, a.season_year, 0) DESC, e.source_updated_at DESC ";
      break;
    case "score":
      sql += " ORDER BY COALESCE(a.average_score, 0) DESC, e.source_updated_at DESC ";
      break;
    default:
      sql += " ORDER BY e.source_updated_at DESC, e.al_id DESC ";
      break;
  }

  sql += " LIMIT ? OFFSET ? ";
  binds.push(limit, offset);

  const rows = await env.DB.prepare(sql).bind(...binds).all<CatalogRow>();
  const items = (rows.results ?? []).map((row) => ({
    alId: row.al_id,
    recordId: row.record_id,
    comparisonLinks: splitLinks(row.comparison),
    excerpt: summarizeNotes(row.notes),
    incomplete: row.incomplete === 1,
    sourceUpdatedAt: row.source_updated_at,
    titles: {
      userPreferred: row.title_user_preferred || null,
      english: row.title_english || null,
      display: row.title_english || row.title_user_preferred || String(row.al_id),
    },
    coverImage: {
      extraLarge: row.cover_image_extra_large || null,
      color: row.cover_image_color || null,
    },
    season: row.season || null,
    seasonYear: row.season_year,
    startYear: row.start_year,
    format: row.format || null,
    status: row.status || null,
    episodes: row.episodes,
    averageScore: row.average_score,
    torrentCount: row.torrent_count,
    bestTorrentCount: row.best_torrent_count,
  }));

  return {
    filters: {
      search,
      format: format || null,
      sort,
      limit,
      offset,
    },
    pagination: {
      count: items.length,
      nextOffset: items.length === limit ? offset + limit : null,
    },
    items,
  };
}

async function getEntryPayload(env: RuntimeEnv, alId: number): Promise<Record<string, unknown>> {
  const entry = await env.DB
    .prepare(
      `
        SELECT
          e.al_id,
          e.record_id,
          e.comparison,
          e.notes,
          e.theoretical_best,
          e.incomplete,
          e.source_created_at,
          e.source_updated_at,
          e.torrent_count,
          e.best_torrent_count,
          COALESCE(a.title_user_preferred, '') AS title_user_preferred,
          COALESCE(a.title_english, '') AS title_english,
          COALESCE(a.cover_image_extra_large, '') AS cover_image_extra_large,
          COALESCE(a.cover_image_color, '') AS cover_image_color,
          COALESCE(a.season, '') AS season,
          a.season_year,
          a.start_year,
          COALESCE(a.format, '') AS format,
          COALESCE(a.status, '') AS status,
          a.episodes,
          a.duration,
          a.average_score,
          COALESCE(a.genres_json, '[]') AS genres_json,
          COALESCE(a.relations_json, '[]') AS relations_json
        FROM entries e
        LEFT JOIN anilist_media a ON a.id = e.al_id
        WHERE e.al_id = ?
      `,
    )
    .bind(alId)
    .first<EntryRow>();

  if (!entry) {
    throw new Error("Entry not found in mirror cache.");
  }

  const torrents = await env.DB
    .prepare(
      `
        SELECT
          source_torrent_id,
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
          source_updated_at
        FROM torrents
        WHERE entry_al_id = ?
        ORDER BY is_best DESC, lower(release_group) ASC, source_torrent_id ASC
      `,
    )
    .bind(alId)
    .all<TorrentRow>();

  return {
    source: {
      originalSite: env.SOURCE_BASE_URL ?? DEFAULT_SOURCE_BASE_URL,
      originalEntryUrl: `${env.SOURCE_BASE_URL ?? DEFAULT_SOURCE_BASE_URL}/${alId}/`,
    },
    entry: {
      alId: entry.al_id,
      recordId: entry.record_id,
      comparisonLinks: splitLinks(entry.comparison),
      notes: entry.notes,
      theoreticalBest: entry.theoretical_best || null,
      incomplete: entry.incomplete === 1,
      sourceCreatedAt: entry.source_created_at,
      sourceUpdatedAt: entry.source_updated_at,
      torrentCount: entry.torrent_count,
      bestTorrentCount: entry.best_torrent_count,
      titles: {
        userPreferred: entry.title_user_preferred || null,
        english: entry.title_english || null,
        display: entry.title_english || entry.title_user_preferred || String(entry.al_id),
      },
      coverImage: {
        extraLarge: entry.cover_image_extra_large || null,
        color: entry.cover_image_color || null,
      },
      season: entry.season || null,
      seasonYear: entry.season_year,
      startYear: entry.start_year,
      format: entry.format || null,
      status: entry.status || null,
      episodes: entry.episodes,
      duration: entry.duration,
      averageScore: entry.average_score,
      genres: safeJsonParse<string[]>(entry.genres_json, []),
      relations: safeJsonParse<unknown[]>(entry.relations_json, []),
    },
    torrents: (torrents.results ?? []).map((torrent) => ({
      id: torrent.source_torrent_id,
      releaseGroup: torrent.release_group,
      tracker: torrent.tracker,
      sourceUrl: torrent.source_url || null,
      url: torrent.resolved_url || torrent.source_url || null,
      sourceGroupedUrl: torrent.source_grouped_url || null,
      groupedUrl: torrent.resolved_grouped_url || torrent.source_grouped_url || null,
      infoHash: torrent.info_hash || null,
      dualAudio: torrent.dual_audio === 1,
      isBest: torrent.is_best === 1,
      tags: safeJsonParse<string[]>(torrent.tags_json, []),
      files: safeJsonParse<Array<{ length: number; name: string }>>(torrent.files_json, []),
      sourceUpdatedAt: torrent.source_updated_at,
    })),
  };
}

function parseEntryId(pathname: string): number | null {
  const match = pathname.match(/^\/api\/v1\/entries\/(\d+)\/?$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function cacheKeyFromRequest(scope: string, url: URL): string {
  const query = url.searchParams.toString();
  return query ? `${scope}?${query}` : scope;
}

function json(
  body: unknown,
  env: RuntimeEnv,
  status = 200,
  cacheable = true,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(env, cacheable, extraHeaders),
  });
}

function jsonHeaders(
  env: RuntimeEnv,
  cacheable: boolean,
  extraHeaders: Record<string, string> = {},
): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheable
      ? `public, max-age=${cacheTtlSecondsFromEnv(env)}, s-maxage=${cacheTtlSecondsFromEnv(env)}`
      : "no-store",
  });

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

function cacheTtlSecondsFromEnv(env: RuntimeEnv): number {
  const parsed = Number.parseInt(env.CACHE_TTL_SECONDS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_SECONDS;
}

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function splitLinks(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeNotes(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
