import "./styles.css";
import {
  filterCatalogItems,
  type CatalogIndexPayload,
  type CatalogItem,
  type EntryPayload,
  type MirrorStatus,
} from "../../shared/mirror";

const DATA_ROOT = "/mirror-data";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found.");
}
const appRoot = app;

boot().catch((error) => {
  appRoot.innerHTML = renderFatal(error instanceof Error ? error.message : String(error));
});

async function boot() {
  const status = await fetchJson<MirrorStatus>(`${DATA_ROOT}/status.json`);
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/") {
    await renderCatalog(status);
    return;
  }

  const match = pathname.match(/^\/(\d+)$/);
  if (!match) {
    appRoot.innerHTML = renderFatal("Unknown route. Return to the index and try again.");
    return;
  }

  await renderEntry(status, Number(match[1]));
}

async function renderCatalog(status: MirrorStatus) {
  const catalog = await fetchJson<CatalogIndexPayload>(`${DATA_ROOT}/catalog.json`);

  appRoot.innerHTML = `
    ${renderShell(status, "catalog")}
    <main class="page page--catalog">
      <section class="hero">
        <div class="hero__copy animate-in">
          <div class="eyebrow">SeaDex mirror / static build</div>
          <h1>Enthusiast releases, mirrored without the quota pain.</h1>
          <p class="lede">
            Your portal to the ultimate enthusiast releases: anime with high-confidence recommendations,
            comparison-backed notes, and cached torrent choices served from a static Pages pipeline.
          </p>
          <div class="hero__actions">
            <a class="button button--primary" href="#catalog-controls">Browse catalog</a>
            <a class="button button--ghost" href="https://releases.moe/" target="_blank" rel="noreferrer">Open SeaDex</a>
          </div>
        </div>
        <aside class="hero__stats animate-in">
          <div class="stat-card">
            <span class="stat-card__label">Entries mirrored</span>
            <strong>${formatNumber(status.counts.entries)}</strong>
            <small>Full SeaDex snapshot, rebuilt offline.</small>
          </div>
          <div class="stat-card">
            <span class="stat-card__label">Torrent rows</span>
            <strong>${formatNumber(status.counts.torrents)}</strong>
            <small>Readable release choices with best-pick flags intact.</small>
          </div>
          <div class="stat-card">
            <span class="stat-card__label">Last rebuild</span>
            <strong>${formatDate(status.sync.lastRebuildFinishedAt)}</strong>
            <small>${status.sync.lastRebuildMode ?? "Static snapshot"} pipeline.</small>
          </div>
        </aside>
      </section>

      <section class="status-strip animate-in">
        ${renderStatusStrip(status)}
      </section>

      <section class="controls" id="catalog-controls">
        <div class="controls__heading">
          <div>
            <div class="eyebrow">Catalog</div>
            <h2>Browse like SeaDex, served like a static site.</h2>
          </div>
          <p>
            Search by title, note text, or AniList id. The list view stays compact and editorial on purpose.
          </p>
        </div>
        <div class="toolbelt">
          <label class="control">
            <span>Search</span>
            <input id="search" type="search" placeholder="Title, note, or AniList id" />
          </label>
          <label class="control">
            <span>Format</span>
            <select id="format">
              <option value="">All formats</option>
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
        </div>
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
      const payload = filterCatalogItems(catalog.items, {
        search: search.value.trim(),
        format: format.value,
        sort: sort.value,
        limit: 24,
        offset,
      });

      if (reset && payload.items.length === 0) {
        stream.innerHTML = "";
        note.textContent = "No mirrored entries matched that filter.";
        loadMore.hidden = true;
        return;
      }

      stream.insertAdjacentHTML("beforeend", payload.items.map(renderCatalogEntry).join(""));
      const shownCount = Math.min(payload.pagination.total, payload.filters.offset + payload.pagination.count);
      offset = payload.pagination.nextOffset ?? payload.filters.offset;
      loadMore.hidden = payload.pagination.nextOffset === null;
      note.textContent =
        payload.pagination.nextOffset === null
          ? `${shownCount} entries loaded from the mirror.`
          : `Showing ${shownCount} of ${payload.pagination.total} mirrored entries.`;
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

  const payload = await fetchJson<EntryPayload>(`${DATA_ROOT}/entries/${alId}.json`);
  const entry = payload.entry;
  const relationCards = renderRelationCards(entry.relations);
  const comparisonLinks = renderComparisonLinks(entry.comparisonLinks);

  appRoot.innerHTML = `
    ${renderShell(status, "entry")}
    <main class="page page--entry">
      <a class="back-link animate-in" href="/">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        Back to index
      </a>

      <section class="entry-hero">
        <div class="entry-poster animate-in">
          ${
            entry.coverImage.extraLarge
              ? `<img src="${escapeHtml(entry.coverImage.extraLarge)}" alt="${escapeHtml(entry.titles.display)} poster" />`
              : `<div class="poster-fallback">AniList art not cached yet.</div>`
          }
        </div>

        <div class="entry-copy animate-in">
          <div class="eyebrow">AniList ${entry.alId}</div>
          <h1>${escapeHtml(entry.titles.display)}</h1>
          <p class="lede">
            SeaDex recommends from a field of ${entry.torrentCount} mirrored release rows, with ${entry.bestTorrentCount}
            best picks highlighted.
          </p>
          <div class="chip-row">
            ${entry.format ? chip(entry.format) : ""}
            ${entry.status ? chip(entry.status) : ""}
            ${entry.startYear ? chip(String(entry.startYear)) : ""}
            ${entry.episodes ? chip(`${entry.episodes} eps`) : ""}
            ${entry.averageScore ? chip(`${entry.averageScore}% score`) : ""}
            ${entry.incomplete ? chip("Incomplete entry") : ""}
          </div>
          <div class="entry-actions">
            <a class="button button--primary" href="${escapeHtml(payload.source.originalEntryUrl)}" target="_blank" rel="noreferrer">Open SeaDex entry</a>
            ${comparisonLinks}
          </div>
        </div>
      </section>

      <section class="entry-grid">
        <article class="entry-panel animate-in">
          <div class="entry-panel__header">
            <div class="eyebrow">Recommendation</div>
            <h2>Editorial notes</h2>
          </div>
          <p class="entry-notes">${escapeHtml(entry.notes || "No note was provided on the source entry.")}</p>
          ${
            entry.theoreticalBest
              ? `<p class="entry-detail"><strong>Theoretical best:</strong> ${escapeHtml(entry.theoreticalBest)}</p>`
              : ""
          }
          <p class="entry-detail"><strong>Mirror updated:</strong> ${formatDate(entry.sourceUpdatedAt)}</p>
        </article>

        <article class="entry-panel animate-in">
          <div class="entry-panel__header">
            <div class="eyebrow">Snapshot</div>
            <h2>Metadata</h2>
          </div>
          <div class="fact-list">
            <span>Season</span><span>${escapeHtml(entry.season ?? "Unknown")}</span>
            <span>Duration</span><span>${entry.duration ? `${entry.duration} min` : "Unknown"}</span>
            <span>Genres</span><span>${entry.genres.length ? escapeHtml(entry.genres.join(", ")) : "None cached"}</span>
            <span>Record id</span><span>${escapeHtml(entry.recordId)}</span>
            <span>Best picks</span><span>${entry.bestTorrentCount}</span>
            <span>Total options</span><span>${entry.torrentCount}</span>
          </div>
        </article>
      </section>

      ${
        relationCards
          ? `
            <section class="entry-panel entry-panel--relations animate-in">
              <div class="entry-panel__header">
                <div class="eyebrow">Franchise context</div>
                <h2>Related titles</h2>
              </div>
              <div class="relation-grid">${relationCards}</div>
            </section>
          `
          : ""
      }

      <section class="entry-panel animate-in">
        <div class="entry-panel__header">
          <div class="eyebrow">Release choices</div>
          <h2>Torrent rows</h2>
        </div>
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
        <span class="brand__copy">
          <strong>SeaDex Mirror</strong>
          <small>Static Pages build, local-friendly generator</small>
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

function renderStatusStrip(status: MirrorStatus) {
  return `
    <article class="status-strip__item">
      <strong>Source parity</strong>
      <p>${status.integrity.listIdParity === "match" ? "List ids match the expanded entry set." : "List parity needs attention."}</p>
    </article>
    <article class="status-strip__item">
      <strong>Static pipeline</strong>
      <p>Normal visitors hit cached JSON files instead of a live quota-limited database.</p>
    </article>
    <article class="status-strip__item">
      <strong>Coverage</strong>
      <p>${formatNumber(status.counts.anilistMedia)} AniList records enriched for this snapshot.</p>
    </article>
  `;
}

function renderCatalogEntry(item: CatalogItem) {
  return `
    <article class="result animate-in">
      <a class="result__link" href="/${item.alId}">
        <div class="result__poster">
          ${
            item.coverImage.extraLarge
              ? `<img src="${escapeHtml(item.coverImage.extraLarge)}" alt="${escapeHtml(item.titles.display)} cover" />`
              : `<div class="poster-fallback poster-fallback--small">No cover cached</div>`
          }
        </div>

        <div class="result__body">
          <div class="result__topline">
            <div class="result__heading">
              <div class="eyebrow">AniList ${item.alId}</div>
              <h2>${escapeHtml(item.titles.display)}</h2>
            </div>
            <div class="result__signals">
              ${item.bestTorrentCount ? `<span class="signal signal--best">${item.bestTorrentCount} best</span>` : `<span class="signal">${item.torrentCount} options</span>`}
              ${item.incomplete ? `<span class="signal signal--warn">Incomplete</span>` : ""}
            </div>
          </div>

          <div class="chip-row chip-row--compact">
            ${item.format ? chip(item.format) : ""}
            ${item.startYear ? chip(String(item.startYear)) : ""}
            ${item.status ? chip(item.status) : ""}
            ${item.comparisonLinks.length ? chip(`${item.comparisonLinks.length} comparison`) : ""}
          </div>

          <p class="result__excerpt">${escapeHtml(item.excerpt ?? "No editorial note cached yet.")}</p>

          <div class="result__footer">
            <span>${formatDate(item.sourceUpdatedAt)}</span>
            <span>${item.torrentCount} torrents mirrored</span>
          </div>
        </div>
      </a>
    </article>
  `;
}

function renderTorrentRow(torrent: EntryPayload["torrents"][number]) {
  const primaryUrl = torrent.url ?? torrent.groupedUrl ?? null;

  return `
    <article class="torrent-row animate-in">
      <div class="torrent-row__main">
        <div class="torrent-row__topline">
          <div>
            <h3>${escapeHtml(torrent.releaseGroup || "Unknown group")}</h3>
            <p class="torrent-row__subtitle">${escapeHtml(torrent.tracker || "Unknown tracker")} / updated ${formatDate(torrent.sourceUpdatedAt)}</p>
          </div>
          <div class="chip-row chip-row--compact">
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
            ? `<a class="button button--primary" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">Open torrent</a>`
            : `<span class="button button--ghost">No source link</span>`
        }
        ${torrent.sourceGroupedUrl ? `<a class="button button--quiet" href="${escapeHtml(torrent.groupedUrl ?? torrent.sourceGroupedUrl)}" target="_blank" rel="noreferrer">Open grouped page</a>` : ""}
        ${torrent.infoHash ? `<code>${escapeHtml(torrent.infoHash)}</code>` : `<span class="muted">Info hash not available</span>`}
      </div>
    </article>
  `;
}

function renderComparisonLinks(links: string[]) {
  if (links.length === 0) {
    return "";
  }

  return links
    .slice(0, 2)
    .map((link, index) => {
      const label = index === 0 ? "Open comparison" : `Comparison ${index + 1}`;
      return `<a class="button button--quiet" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">${label}</a>`;
    })
    .join("");
}

function renderRelationCards(relations: EntryPayload["entry"]["relations"]) {
  return relations
    .filter((relation) => relation.node?.id && relation.node.title)
    .slice(0, 12)
    .map((relation) => {
      const node = relation.node!;
      const title = node.title?.english ?? node.title?.userPreferred ?? String(node.id);
      const year = node.startDate?.year ?? node.seasonYear ?? null;
      return `
        <article class="relation-card">
          <div class="relation-card__poster">
            ${
              node.coverImage?.extraLarge
                ? `<img src="${escapeHtml(node.coverImage.extraLarge)}" alt="${escapeHtml(title)} cover" />`
                : `<div class="poster-fallback poster-fallback--small">No art</div>`
            }
          </div>
          <div class="relation-card__body">
            <span class="relation-card__type">${formatRelationType(relation.relationType)}</span>
            <h3>${escapeHtml(title)}</h3>
            <p>${[node.format, year ? String(year) : null, node.episodes ? `${node.episodes} eps` : null].filter(Boolean).join(" / ") || "Metadata unavailable"}</p>
            <a class="relation-card__link" href="https://anilist.co/anime/${node.id}" target="_blank" rel="noreferrer">View on AniList</a>
          </div>
        </article>
      `;
    })
    .join("");
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

function chip(label: string) {
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    if (response.status === 404 && url.startsWith(DATA_ROOT)) {
      throw new Error(`Mirror data is missing at ${url}. Run \`npm run data:build\` before previewing the site.`);
    }

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

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatRelationType(value: string | null | undefined) {
  if (!value) {
    return "Related";
  }

  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
