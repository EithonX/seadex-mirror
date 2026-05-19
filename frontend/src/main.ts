import "./styles.css";

type MirrorStatus = {
  mirror: {
    sourceBaseUrl: string;
    originalSite: string;
    attribution: string;
    disclaimer: string;
  };
  counts: {
    entries: number;
    torrents: number;
    anilistMedia: number;
  };
  integrity: {
    entriesWithoutTorrents: number;
    entriesWithoutAniList: number;
    sourceListIdCount: number;
    sourceEntryCount: number;
    sourceTorrentCount: number;
    listIdParity: string | null;
    expandedTorrentParity: string | null;
  };
  sync: {
    lastRebuildStartedAt: string | null;
    lastRebuildFinishedAt: string | null;
    lastRebuildMode: string | null;
    lastError: string | null;
    summary: Record<string, unknown> | null;
  };
};

type CatalogItem = {
  alId: number;
  recordId: string;
  comparisonLinks: string[];
  excerpt: string | null;
  incomplete: boolean;
  sourceUpdatedAt: string;
  titles: {
    userPreferred: string | null;
    english: string | null;
    display: string;
  };
  coverImage: {
    extraLarge: string | null;
    color: string | null;
  };
  season: string | null;
  seasonYear: number | null;
  startYear: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  averageScore: number | null;
  torrentCount: number;
  bestTorrentCount: number;
};

type CatalogPayload = {
  pagination: {
    count: number;
    nextOffset: number | null;
  };
  items: CatalogItem[];
};

type EntryPayload = {
  source: {
    originalSite: string;
    originalEntryUrl: string;
  };
  entry: {
    alId: number;
    recordId: string;
    comparisonLinks: string[];
    notes: string;
    theoreticalBest: string | null;
    incomplete: boolean;
    sourceCreatedAt: string;
    sourceUpdatedAt: string;
    torrentCount: number;
    bestTorrentCount: number;
    titles: {
      userPreferred: string | null;
      english: string | null;
      display: string;
    };
    coverImage: {
      extraLarge: string | null;
      color: string | null;
    };
    season: string | null;
    seasonYear: number | null;
    startYear: number | null;
    format: string | null;
    status: string | null;
    episodes: number | null;
    duration: number | null;
    averageScore: number | null;
    genres: string[];
    relations: Array<{ node?: { id?: number; title?: { userPreferred?: string | null; english?: string | null } } }>;
  };
  torrents: Array<{
    id: string;
    releaseGroup: string;
    tracker: string;
    sourceUrl: string | null;
    url: string | null;
    sourceGroupedUrl: string | null;
    groupedUrl: string | null;
    infoHash: string | null;
    dualAudio: boolean;
    isBest: boolean;
    tags: string[];
    files: Array<{ length: number; name: string }>;
    sourceUpdatedAt: string;
  }>;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found.");
}
const appRoot = app;

boot().catch((error) => {
  appRoot.innerHTML = renderFatal(error instanceof Error ? error.message : String(error));
});

async function boot() {
  const status = await fetchJson<MirrorStatus>("/api/v1/status");
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/") {
    await renderCatalog(status);
    return;
  }

  const match = pathname.match(/^\/(\d+)$/);
  if (!match) {
    appRoot.innerHTML = renderFatal("Unknown route. Return to the catalog and try again.");
    return;
  }

  await renderEntry(status, Number(match[1]));
}

async function renderCatalog(status: MirrorStatus) {
  appRoot.innerHTML = `
    ${renderShell(status, "catalog")}
    <main class="page page--catalog">
      <section class="masthead">
        <div class="eyebrow">Unofficial mirror</div>
        <h1>SeaDex, rebuilt for resilience.</h1>
        <p class="lede">
          Cached release recommendations, torrent choices, and AniList metadata, served from a calmer pipeline
          that prefers accuracy over improvisation.
        </p>
        <div class="masthead__meta">
          <span>${status.counts.entries} entries mirrored</span>
          <span>${status.counts.torrents} torrent rows cached</span>
          <span>${formatDate(status.sync.lastRebuildFinishedAt)} last rebuild</span>
        </div>
      </section>

      <section class="status-band">
        ${renderStatusBand(status)}
      </section>

      <section class="toolbelt">
        <label class="control">
          <span>Search</span>
          <input id="search" type="search" placeholder="Title, note, or AniList id" />
        </label>
        <label class="control">
          <span>Format</span>
          <select id="format">
            <option value="">All</option>
            <option value="TV">TV</option>
            <option value="MOVIE">Movie</option>
            <option value="OVA">OVA</option>
            <option value="ONA">ONA</option>
            <option value="SPECIAL">Special</option>
          </select>
        </label>
        <label class="control">
          <span>Sort</span>
          <select id="sort">
            <option value="updated">Recently updated</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
            <option value="score">Score</option>
          </select>
        </label>
      </section>

      <section class="catalog-note" id="catalog-note">Loading mirrored entries...</section>
      <section class="catalog-stream" id="catalog-stream"></section>
      <div class="catalog-footer">
        <button class="load-more" id="load-more">Load more</button>
      </div>
    </main>
  `;

  const search = query<HTMLInputElement>("#search");
  const format = query<HTMLSelectElement>("#format");
  const sort = query<HTMLSelectElement>("#sort");
  const note = query<HTMLElement>("#catalog-note");
  const stream = query<HTMLElement>("#catalog-stream");
  const loadMore = query<HTMLButtonElement>("#load-more");

  let offset = 0;
  let loading = false;

  const load = async (reset: boolean) => {
    if (loading) {
      return;
    }

    loading = true;
    if (reset) {
      offset = 0;
      stream.innerHTML = "";
    }

    note.textContent = "Loading mirrored entries...";

    try {
      const params = new URLSearchParams({
        search: search.value.trim(),
        format: format.value,
        sort: sort.value,
        limit: "18",
        offset: String(offset),
      });

      const payload = await fetchJson<CatalogPayload>(`/api/v1/catalog?${params.toString()}`);
      if (reset && payload.items.length === 0) {
        stream.innerHTML = "";
        note.textContent = "No mirrored entries matched that filter.";
        loadMore.hidden = true;
        return;
      }

      stream.insertAdjacentHTML("beforeend", payload.items.map(renderCatalogEntry).join(""));
      offset = payload.pagination.nextOffset ?? offset;
      loadMore.hidden = payload.pagination.nextOffset === null;
      note.textContent =
        payload.pagination.nextOffset === null
          ? `${payload.items.length + (reset ? 0 : offset)} entries loaded from the mirror.`
          : "Showing the current slice of mirrored entries.";
    } catch (error) {
      note.textContent = `Catalog load failed: ${error instanceof Error ? error.message : String(error)}`;
      loadMore.hidden = true;
    } finally {
      loading = false;
    }
  };

  const debouncedReset = debounce(() => {
    void load(true);
  }, 220);

  search.addEventListener("input", debouncedReset);
  format.addEventListener("change", () => void load(true));
  sort.addEventListener("change", () => void load(true));
  loadMore.addEventListener("click", () => void load(false));

  await load(true);
}

async function renderEntry(status: MirrorStatus, alId: number) {
  appRoot.innerHTML = `
    ${renderShell(status, "entry")}
    <main class="page page--entry">
      <section class="entry-loading">Loading mirrored entry...</section>
    </main>
  `;

  const payload = await fetchJson<EntryPayload>(`/api/v1/entries/${alId}`);
  const entry = payload.entry;

  appRoot.innerHTML = `
    ${renderShell(status, "entry")}
    <main class="page page--entry animate-in">
      <a class="back-link" href="/">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        Return to catalog
      </a>
      <section class="entry-hero">
        <div class="entry-poster">
          ${
            entry.coverImage.extraLarge
              ? `<img src="${escapeHtml(entry.coverImage.extraLarge)}" alt="${escapeHtml(entry.titles.display)} poster" />`
              : `<div class="poster-fallback">AniList art not cached yet.</div>`
          }
        </div>
        <div class="entry-copy">
          <div class="eyebrow">AniList ${entry.alId}</div>
          <h1>${escapeHtml(entry.titles.display)}</h1>
          <p class="lede">
            Mirrored from SeaDex with ${entry.torrentCount} cached torrent rows and ${entry.bestTorrentCount} marked best picks.
          </p>
          <div class="chip-row">
            ${entry.format ? chip(entry.format) : ""}
            ${entry.status ? chip(entry.status) : ""}
            ${entry.startYear ? chip(String(entry.startYear)) : ""}
            ${entry.episodes ? chip(`${entry.episodes} eps`) : ""}
            ${entry.averageScore ? chip(`${entry.averageScore}%`) : ""}
            ${entry.incomplete ? chip("Marked incomplete") : ""}
          </div>
          <div class="entry-actions">
            <a class="button button--primary" href="${escapeHtml(payload.source.originalEntryUrl)}" target="_blank" rel="noreferrer">
              Open original SeaDex entry
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
            ${
              entry.comparisonLinks[0]
                ? `<a class="button button--quiet" href="${escapeHtml(entry.comparisonLinks[0])}" target="_blank" rel="noreferrer">
                    Open comparison
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                   </a>`
                : ""
            }
          </div>
        </div>
      </section>

      <section class="entry-grid">
        <article class="entry-panel">
          <h2>Editorial notes</h2>
          <p>${escapeHtml(entry.notes || "No note was provided on the source entry.")}</p>
          ${
            entry.theoreticalBest
              ? `<p class="entry-detail"><strong>Theoretical best:</strong> ${escapeHtml(entry.theoreticalBest)}</p>`
              : ""
          }
          <p class="entry-detail"><strong>Mirrored update:</strong> ${formatDate(entry.sourceUpdatedAt)}</p>
        </article>

        <article class="entry-panel">
          <h2>Metadata</h2>
          <div class="fact-list">
            <span>Season</span><span>${escapeHtml(entry.season ?? "Unknown")}</span>
            <span>Duration</span><span>${entry.duration ? `${entry.duration} min` : "Unknown"}</span>
            <span>Genres</span><span>${entry.genres.length ? escapeHtml(entry.genres.join(", ")) : "None cached"}</span>
            <span>Record id</span><span>${escapeHtml(entry.recordId)}</span>
          </div>
        </article>
      </section>

      <section class="entry-panel">
        <h2>Torrent choices</h2>
        <div class="torrent-table">
          ${payload.torrents.map(renderTorrentRow).join("")}
        </div>
      </section>
    </main>
  `;
}

function renderShell(status: MirrorStatus, page: "catalog" | "entry") {
  return `
    <header class="frame">
      <a class="brand" href="/">
        <span class="brand__badge">SM</span>
        <span>
          <strong>SeaDex Mirror</strong>
          <small>Community resilience build</small>
        </span>
      </a>
      <div class="frame__meta">
        <span>${status.integrity.entriesWithoutTorrents} torrent gaps</span>
        <span>${status.integrity.entriesWithoutAniList} AniList gaps</span>
        <span>${formatDate(status.sync.lastRebuildFinishedAt)}</span>
      </div>
    </header>
    <div class="shell shell--${page}"></div>
  `;
}

function renderStatusBand(status: MirrorStatus) {
  const listParity = status.integrity.listIdParity === "match" ? "List parity locked." : "List parity needs attention.";
  const torrentParity =
    status.integrity.expandedTorrentParity === "match" ? "Expanded torrents are aligned." : "Expanded torrents need review.";

  return `
    <div class="status-band__item">
      <strong>Source integrity</strong>
      <p>${listParity} ${torrentParity}</p>
    </div>
    <div class="status-band__item">
      <strong>Mirror coverage</strong>
      <p>${status.counts.entries} entries, ${status.counts.torrents} torrent rows, ${status.counts.anilistMedia} AniList records.</p>
    </div>
    <div class="status-band__item">
      <strong>Current risk</strong>
      <p>${
        status.sync.lastError
          ? `Last rebuild hit an error: ${escapeHtml(status.sync.lastError)}`
          : "No active rebuild error is cached."
      }</p>
    </div>
  `;
}

function renderCatalogEntry(item: CatalogItem) {
  return `
    <article class="result animate-in" style="animation-delay: ${Math.random() * 0.15}s;">
      <a class="result__link" href="/${item.alId}">
        <div class="result__poster">
          ${
            item.coverImage.extraLarge
              ? `<img src="${escapeHtml(item.coverImage.extraLarge)}" alt="${escapeHtml(item.titles.display)} cover" />`
              : `<div class="poster-fallback poster-fallback--small">No cover cached</div>`
          }
        </div>
        <div class="result__body">
          <div class="result__heading">
            <div class="eyebrow">AniList ${item.alId}</div>
            <h2>${escapeHtml(item.titles.display)}</h2>
          </div>
          <div class="chip-row chip-row--compact">
            ${item.format ? chip(item.format) : ""}
            ${item.startYear ? chip(String(item.startYear)) : ""}
            ${item.bestTorrentCount ? chip(`${item.bestTorrentCount} best`) : chip(`${item.torrentCount} options`)}
            ${item.incomplete ? chip("Incomplete") : ""}
          </div>
          <p class="result__excerpt">${escapeHtml(item.excerpt ?? "No editorial note cached yet.")}</p>
          <div class="result__footer">
            <span>${formatDate(item.sourceUpdatedAt)}</span>
            <span>${item.torrentCount} torrents</span>
          </div>
        </div>
      </a>
    </article>
  `;
}

function renderTorrentRow(torrent: EntryPayload["torrents"][number]) {
  const primaryUrl = torrent.url ?? torrent.groupedUrl ?? null;
  return `
    <article class="torrent-row animate-in" style="animation-delay: ${Math.random() * 0.15}s;">
      <div class="torrent-row__main">
        <div class="torrent-row__topline">
          <h3>${escapeHtml(torrent.releaseGroup || "Unknown group")}</h3>
          <div class="chip-row chip-row--compact">
            ${chip(torrent.tracker || "Unknown")}
            ${torrent.isBest ? chip("Best pick") : chip("Alt pick")}
            ${torrent.dualAudio ? chip("Dual audio") : chip("Single audio")}
            ${torrent.tags.map((tag) => chip(tag)).join("")}
          </div>
        </div>
        <ul class="file-list">
          ${torrent.files.slice(0, 6).map((file) => `<li>${escapeHtml(file.name)} <span>${formatBytes(file.length)}</span></li>`).join("")}
        </ul>
      </div>
      <div class="torrent-row__actions">
        ${
          primaryUrl
            ? `<a class="button button--primary" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">
                 Open torrent
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
               </a>`
            : `<span class="button button--ghost">No source link</span>`
        }
        ${torrent.infoHash ? `<code>${escapeHtml(torrent.infoHash)}</code>` : `<span class="muted">Info hash redacted</span>`}
      </div>
    </article>
  `;
}

function renderFatal(message: string) {
  return `
    <main class="fatal">
      <div class="fatal__panel">
        <div class="eyebrow">Mirror failure</div>
        <h1>Something slipped.</h1>
        <p>${escapeHtml(message)}</p>
        <a class="button button--primary" href="/">Return home</a>
      </div>
    </main>
  `;
}

function chip(label: string, iconHtml: string = "") {
  return `<span class="chip">${iconHtml}${escapeHtml(label)}</span>`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing required node: ${selector}`);
  }
  return node;
}

function debounce(callback: () => void, delayMs: number) {
  let timeoutId: number | null = null;
  return () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      callback();
    }, delayMs);
  };
}

function formatDate(value: string | null) {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Unknown size";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
