import "./styles.css";
import {
  filterCatalogItems,
  type CatalogIndexItem,
  type CatalogIndexPayload,
  type CatalogItem,
  type CatalogPayload,
  type EntryPayload,
  type MirrorStatus,
} from "../../shared/mirror";

const DATA_ROOT = "/mirror-data";
const DEFAULT_PAGE_SIZE = 30;
const SEARCH_RESULTS_LIMIT = 10;
const THEME_KEY = "seadex-mirror-theme";

type RouteContext = { kind: "index" } | { kind: "entry"; alId: number };

type CatalogState = {
  search: string;
  format: string;
  season: string;
  sort: string;
  limit: number;
  offset: number;
};

type CatalogGroupSummary = {
  bestLabel: string;
  altLabel: string;
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found.");
}
const appRoot = app;

let cachedCatalogPromise: Promise<CatalogIndexPayload> | null = null;
const groupSummaryCache = new Map<number, CatalogGroupSummary>();
const groupSummaryInflight = new Map<number, Promise<void>>();
let globalKeydownCleanup: (() => void) | null = null;

applySavedTheme();

boot().catch((error) => {
  appRoot.innerHTML = renderFatal(error instanceof Error ? error.message : String(error));
});

async function boot() {
  const status = await fetchJson<MirrorStatus>(`${DATA_ROOT}/status.json`);
  const route = parseRoute(window.location.pathname);

  if (route.kind === "index") {
    await renderCatalog(status);
    return;
  }

  await renderEntry(status, route.alId);
}

function parseRoute(pathname: string): RouteContext {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    return { kind: "index" };
  }

  const match = normalized.match(/^\/(\d+)$/);
  if (!match) {
    throw new Error("Unknown route. Return to the index and try again.");
  }

  return { kind: "entry", alId: Number(match[1]) };
}

async function renderCatalog(status: MirrorStatus) {
  const catalog = await getCatalog();
  const state = readCatalogStateFromUrl();
  const seasonOptions = buildSeasonOptions(catalog.items);

  appRoot.innerHTML = renderPageFrame(
    status,
    "index",
    `
      <main class="page page--catalog">
        <section class="catalog-page">
          <div class="catalog-toolbar">
            <div class="catalog-toolbar__group catalog-toolbar__group--grow">
              <label class="control-shell control-shell--search" for="catalog-search">
                ${renderSearchIcon()}
                <input id="catalog-search" class="control-input" type="search" placeholder="Search anime..." value="${escapeHtml(state.search)}" autocomplete="off" />
              </label>
              <label class="control-select control-select--dashed">
                <span>Format</span>
                <select id="catalog-format">
                  <option value="">All formats</option>
                  ${renderFormatOptions(state.format)}
                </select>
              </label>
              <label class="control-select">
                <span>Season</span>
                <select id="catalog-season">
                  <option value="">All seasons</option>
                  ${seasonOptions
                    .map(
                      (option) =>
                        `<option value="${escapeHtml(option.value)}"${option.value === state.season ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
                    )
                    .join("")}
                </select>
              </label>
            </div>
            <div class="catalog-toolbar__group">
              <label class="control-select">
                <span>View</span>
                <select id="catalog-sort">
                  <option value="updated"${state.sort === "updated" ? " selected" : ""}>Latest updates</option>
                  <option value="title"${state.sort === "title" ? " selected" : ""}>Alphabetical</option>
                  <option value="year"${state.sort === "year" ? " selected" : ""}>Newest year</option>
                  <option value="score"${state.sort === "score" ? " selected" : ""}>Highest score</option>
                </select>
              </label>
            </div>
          </div>

          <section class="catalog-table-shell">
            <div class="catalog-table-shell__scroll">
              <table class="catalog-table" aria-label="SeaDex mirror catalog">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Format</th>
                    <th>Year</th>
                    <th>Episodes</th>
                    <th>Best</th>
                    <th>Alt</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="catalog-body"></tbody>
              </table>
            </div>
            <div id="catalog-mobile" class="catalog-mobile"></div>
          </section>

          <div class="catalog-footer">
            <div class="catalog-footer__summary" id="catalog-summary">Loading rows...</div>
            <div class="catalog-footer__controls">
              <label class="rows-control">
                <span>Rows per page</span>
                <select id="catalog-limit">
                  <option value="15"${state.limit === 15 ? " selected" : ""}>15</option>
                  <option value="30"${state.limit === 30 ? " selected" : ""}>30</option>
                  <option value="60"${state.limit === 60 ? " selected" : ""}>60</option>
                  <option value="90"${state.limit === 90 ? " selected" : ""}>90</option>
                </select>
              </label>
              <div class="page-indicator" id="catalog-indicator">Page 1 of 1</div>
              <div class="pager">
                <button id="catalog-first" class="ghost-icon-button ghost-icon-button--desktop" type="button" aria-label="Go to first page">${renderDoubleChevronLeftIcon()}</button>
                <button id="catalog-prev" class="ghost-icon-button" type="button" aria-label="Go to previous page">${renderChevronLeftIcon()}</button>
                <button id="catalog-next" class="ghost-icon-button" type="button" aria-label="Go to next page">${renderChevronRightIcon()}</button>
                <button id="catalog-last" class="ghost-icon-button ghost-icon-button--desktop" type="button" aria-label="Go to last page">${renderDoubleChevronRightIcon()}</button>
              </div>
            </div>
          </div>

          <footer class="catalog-meta">
            <span>${status.counts.entries} mirrored entries</span>
            <span>${status.counts.torrents} torrent rows</span>
            <span>${status.integrity.listIdParity === "match" ? "List parity locked" : "Parity warning"}</span>
            <span>Updated ${formatDate(status.sync.lastRebuildFinishedAt)}</span>
          </footer>
        </section>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "index");

  const searchInput = query<HTMLInputElement>("#catalog-search");
  const formatSelect = query<HTMLSelectElement>("#catalog-format");
  const seasonSelect = query<HTMLSelectElement>("#catalog-season");
  const sortSelect = query<HTMLSelectElement>("#catalog-sort");
  const limitSelect = query<HTMLSelectElement>("#catalog-limit");
  const body = query<HTMLTableSectionElement>("#catalog-body");
  const mobileList = query<HTMLDivElement>("#catalog-mobile");
  const summary = query<HTMLDivElement>("#catalog-summary");
  const indicator = query<HTMLDivElement>("#catalog-indicator");
  const firstButton = query<HTMLButtonElement>("#catalog-first");
  const prevButton = query<HTMLButtonElement>("#catalog-prev");
  const nextButton = query<HTMLButtonElement>("#catalog-next");
  const lastButton = query<HTMLButtonElement>("#catalog-last");

  let renderToken = 0;
  let currentPayload: CatalogPayload | null = null;

  const renderPage = () => {
    renderToken += 1;
    const activeRenderToken = renderToken;

    state.search = searchInput.value.trim();
    state.format = formatSelect.value;
    state.season = seasonSelect.value;
    state.sort = sortSelect.value;
    state.limit = Number.parseInt(limitSelect.value, 10) || DEFAULT_PAGE_SIZE;

    const filteredItems = filterSeason(catalog.items, state.season);
    currentPayload = filterCatalogItems(filteredItems, {
      search: state.search,
      format: state.format,
      sort: state.sort,
      limit: state.limit,
      offset: state.offset,
    });

    syncCatalogStateToUrl(state);

    const totalPages = Math.max(1, Math.ceil(currentPayload.pagination.total / state.limit));
    const currentPage = currentPayload.pagination.total === 0 ? 0 : Math.floor(state.offset / state.limit) + 1;

    if (currentPayload.items.length === 0) {
      body.innerHTML = `
        <tr>
          <td class="catalog-empty" colspan="8">No mirrored entries matched that filter.</td>
        </tr>
      `;
      mobileList.innerHTML = `
        <div class="catalog-empty catalog-empty--mobile">
          No mirrored entries matched that filter.
        </div>
      `;
      summary.textContent = "0 row(s) loaded.";
      indicator.textContent = "Page 0 of 0";
      firstButton.disabled = true;
      prevButton.disabled = true;
      nextButton.disabled = true;
      lastButton.disabled = true;
      return;
    }

    body.innerHTML = currentPayload.items.map(renderCatalogRow).join("");
    mobileList.innerHTML = currentPayload.items.map(renderCatalogMobileCard).join("");
    summary.textContent = `${currentPayload.items.length} row(s) loaded.`;
    indicator.textContent = `Page ${currentPage} of ${totalPages}`;

    firstButton.disabled = currentPage <= 1;
    prevButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage >= totalPages;
    lastButton.disabled = currentPage >= totalPages;

    wireCatalogActions(body, mobileList);

    void ensureGroupSummaries(currentPayload.items).then(() => {
      if (renderToken !== activeRenderToken) {
        return;
      }
      body.innerHTML = currentPayload!.items.map(renderCatalogRow).join("");
      mobileList.innerHTML = currentPayload!.items.map(renderCatalogMobileCard).join("");
      wireCatalogActions(body, mobileList);
    });
  };

  const resetAndRender = () => {
    state.offset = 0;
    renderPage();
  };

  const debouncedRender = debounce(resetAndRender, 120);

  searchInput.addEventListener("input", debouncedRender);
  formatSelect.addEventListener("change", resetAndRender);
  seasonSelect.addEventListener("change", resetAndRender);
  sortSelect.addEventListener("change", resetAndRender);
  limitSelect.addEventListener("change", resetAndRender);

  firstButton.addEventListener("click", () => {
    state.offset = 0;
    renderPage();
  });

  prevButton.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    renderPage();
  });

  nextButton.addEventListener("click", () => {
    if (!currentPayload?.pagination.nextOffset && currentPayload?.pagination.nextOffset !== 0) {
      return;
    }
    state.offset = currentPayload.pagination.nextOffset ?? state.offset;
    renderPage();
  });

  lastButton.addEventListener("click", () => {
    if (!currentPayload) {
      return;
    }
    const totalPages = Math.max(1, Math.ceil(currentPayload.pagination.total / state.limit));
    state.offset = (totalPages - 1) * state.limit;
    renderPage();
  });

  renderPage();
}

async function renderEntry(status: MirrorStatus, alId: number) {
  appRoot.innerHTML = renderPageFrame(
    status,
    "entry",
    `
      <main class="page page--entry">
        <div class="entry-loading">Loading mirrored entry...</div>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "entry");

  const payload = await fetchJson<EntryPayload>(`${DATA_ROOT}/entries/${alId}.json`);
  const entry = payload.entry;
  const bestLabel = entry.theoreticalBest ? `<p class="entry-notes__extra"><strong>Theoretical best:</strong> ${escapeHtml(entry.theoreticalBest)}</p>` : "";

  appRoot.innerHTML = renderPageFrame(
    status,
    "entry",
    `
      <main class="page page--entry">
        <div class="entry-layout">
          <aside class="entry-sidebar">
            <section class="entry-hero">
              <div class="entry-hero__poster">
                <a href="https://anilist.co/anime/${entry.alId}" target="_blank" rel="noreferrer">
                  ${
                    entry.coverImage.extraLarge
                      ? `<img src="${escapeHtml(entry.coverImage.extraLarge)}" alt="${escapeHtml(entry.titles.display)} cover" />`
                      : `<div class="poster-fallback">No poster art was included in the snapshot.</div>`
                  }
                </a>
              </div>
              <div class="entry-hero__body">
                <h1>${escapeHtml(entry.titles.english ?? entry.titles.display)}</h1>
                ${
                  entry.titles.userPreferred && entry.titles.userPreferred !== entry.titles.english
                    ? `<h2>${escapeHtml(entry.titles.userPreferred)}</h2>`
                    : ""
                }
                <div class="entry-meta-row">
                  <span>${renderCalendarIcon()} ${entry.startYear ?? "Unknown"}</span>
                  <span>${escapeHtml(formatSeriesLabel(entry))} ${renderFormatIcon()}</span>
                </div>
                <div class="entry-meta-row">
                  <span title="Created on">${renderCalendarPlusIcon()} ${formatDate(entry.sourceCreatedAt)}</span>
                  <span title="Updated on">${formatDate(entry.sourceUpdatedAt)} ${renderCalendarUpIcon()}</span>
                </div>
              </div>
            </section>

            ${entry.comparisonLinks.length ? renderComparisonsSection(entry.comparisonLinks) : ""}

            <hr class="section-rule" />

            <section class="sidebar-section">
              <h3>Links</h3>
              <div class="sidebar-stack">
                <a class="comparison-link comparison-link--secondary" href="${escapeHtml(payload.source.originalEntryUrl)}" target="_blank" rel="noreferrer">
                  <span>${renderLogInIcon()}</span>
                  <span>Open original SeaDex page</span>
                </a>
                <a class="comparison-link comparison-link--secondary" href="https://anilist.co/anime/${entry.alId}" target="_blank" rel="noreferrer">
                  <span>${renderExternalIcon()}</span>
                  <span>View on AniList</span>
                </a>
              </div>
            </section>
          </aside>

          <section class="entry-main">
            <section class="content-section">
              <h2>Torrents</h2>
              <div class="torrent-grid">
                ${payload.torrents.map(renderTorrentCard).join("")}
              </div>
            </section>

            <hr class="section-divider" />

            <section class="content-section">
              <h2>Notes</h2>
              <div class="entry-notes">${escapeHtml(entry.notes || "No notes were included for this entry.")}</div>
              ${bestLabel}
            </section>

            ${renderRelationsSection(entry.relations)}

            <hr class="section-divider" />

            <section class="content-section content-section--subtle">
              <div class="mirror-inline">
                <span>${status.counts.entries} mirrored entries</span>
                <span>${status.integrity.expandedTorrentParity === "match" ? "Expanded torrent parity locked" : "Parity warning"}</span>
                <span>Snapshot ${formatDate(status.sync.lastRebuildFinishedAt)}</span>
              </div>
            </section>
          </section>
        </div>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "entry");
}

function renderPageFrame(status: MirrorStatus, context: "index" | "entry", content: string) {
  return `
    ${renderShell(status, context)}
    ${content}
  `;
}

function renderShell(status: MirrorStatus, context: "index" | "entry") {
  return `
    <header class="site-header">
      <div class="site-header__inner">
        <div class="site-header__brand">
          <a href="/" class="brand-link" aria-label="SeaDex mirror home">
            <span class="brand-mark">${renderBrandMark()}</span>
            <span class="brand-label">SeaDex</span>
          </a>
          <nav class="site-nav" aria-label="Primary navigation">
            <a href="https://releases.moe/about/" target="_blank" rel="noreferrer">About</a>
            <a href="https://discord.com/invite/jPeeZewWRn" target="_blank" rel="noreferrer">Discord</a>
            <a href="https://sheet.releases.moe" target="_blank" rel="noreferrer">Sheet</a>
          </nav>
        </div>

        <button id="global-search-trigger" class="header-search" type="button" aria-haspopup="dialog" aria-controls="search-dialog" aria-expanded="false">
          ${renderSearchIcon()}
          <span>Search anime...</span>
        </button>

        <div class="site-header__actions">
          <a class="ghost-icon-button" href="${escapeHtml(status.mirror.originalSite)}" target="_blank" rel="noreferrer" aria-label="Open original SeaDex site">
            ${renderLogInIcon()}
          </a>
          <button id="theme-toggle" class="ghost-icon-button" type="button" aria-label="Toggle theme">
            <span class="theme-sun">${renderSunIcon()}</span>
            <span class="theme-moon">${renderMoonIcon()}</span>
          </button>
        </div>
      </div>
      ${
        context === "entry"
          ? `<div class="site-header__context"><a class="site-header__back" href="/">${renderChevronLeftIcon()} Back to catalog</a></div>`
          : ""
      }
    </header>
  `;
}

function renderSearchDialog() {
  return `
    <div id="search-dialog" class="search-dialog" hidden aria-hidden="true">
      <div class="search-dialog__backdrop" data-search-close></div>
      <div class="search-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="search-dialog-title">
        <div class="search-dialog__header">
          <h2 id="search-dialog-title">Search anime</h2>
          <button type="button" class="ghost-icon-button" data-search-close aria-label="Close search">${renderCloseIcon()}</button>
        </div>
        <label class="control-shell control-shell--search control-shell--dialog" for="dialog-search-input">
          ${renderSearchIcon()}
          <input id="dialog-search-input" class="control-input" type="search" placeholder="Type a title, year, or note fragment..." autocomplete="off" />
        </label>
        <div class="search-dialog__meta" id="dialog-search-meta">Start typing to search the mirrored catalog.</div>
        <div id="dialog-search-results" class="search-results"></div>
      </div>
    </div>
  `;
}

function renderFormatOptions(activeFormat: string) {
  return [
    ["TV", "TV Series"],
    ["TV_SHORT", "TV Short"],
    ["MOVIE", "Movie"],
    ["OVA", "OVA"],
    ["ONA", "ONA"],
    ["SPECIAL", "Special"],
    ["MUSIC", "Music"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${activeFormat === value ? " selected" : ""}>${label}</option>`,
    )
    .join("");
}

function renderCatalogRow(item: CatalogItem) {
  const groups = readGroupSummary(item);
  const year = item.startYear ?? item.seasonYear ?? "-";

  return `
    <tr class="catalog-row" data-entry-link="/${item.alId}" tabindex="0">
      <td>
        <div class="catalog-title">
          <span class="catalog-title__text">${escapeHtml(item.titles.display)}</span>
          ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
        </div>
      </td>
      <td>${escapeHtml(formatCatalogFormat(item.format))}</td>
      <td>${year}</td>
      <td>${item.episodes ?? "-"}</td>
      <td>${escapeHtml(groups.bestLabel)}</td>
      <td>${escapeHtml(groups.altLabel)}</td>
      <td>${formatDate(item.sourceUpdatedAt)}</td>
      <td class="catalog-row__actions">
        <div class="row-menu-shell">
          <button class="row-menu-toggle" type="button" aria-label="Open row menu" data-menu-toggle data-menu-id="row-menu-${item.alId}">
            ${renderDotsIcon()}
          </button>
          <div id="row-menu-${item.alId}" class="row-menu" hidden>
            <a href="/${item.alId}">Open entry</a>
            <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer">AniList</a>
            ${
              item.comparisonLinks[0]
                ? `<a href="${escapeHtml(item.comparisonLinks[0])}" target="_blank" rel="noreferrer">First comparison</a>`
                : ""
            }
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderCatalogMobileCard(item: CatalogItem) {
  const groups = readGroupSummary(item);
  const year = item.startYear ?? item.seasonYear ?? "Unknown";

  return `
    <article class="catalog-card" data-entry-link="/${item.alId}" tabindex="0">
      <div class="catalog-card__top">
        <div class="catalog-card__title">
          <strong>${escapeHtml(item.titles.display)}</strong>
          ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
        </div>
        <button class="row-menu-toggle" type="button" aria-label="Open row menu" data-menu-toggle data-menu-id="mobile-row-menu-${item.alId}">
          ${renderDotsIcon()}
        </button>
        <div id="mobile-row-menu-${item.alId}" class="row-menu row-menu--mobile" hidden>
          <a href="/${item.alId}">Open entry</a>
          <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer">AniList</a>
          ${
            item.comparisonLinks[0]
              ? `<a href="${escapeHtml(item.comparisonLinks[0])}" target="_blank" rel="noreferrer">First comparison</a>`
              : ""
          }
        </div>
      </div>
      <div class="catalog-card__meta">
        <span>${escapeHtml(formatCatalogFormat(item.format))}</span>
        <span>${year}</span>
        <span>${item.episodes ?? "?"} ep</span>
      </div>
      <dl class="catalog-card__groups">
        <div>
          <dt>Best</dt>
          <dd>${escapeHtml(groups.bestLabel)}</dd>
        </div>
        <div>
          <dt>Alt</dt>
          <dd>${escapeHtml(groups.altLabel)}</dd>
        </div>
      </dl>
      <div class="catalog-card__footer">Updated ${formatDate(item.sourceUpdatedAt)}</div>
    </article>
  `;
}

function renderComparisonsSection(links: string[]) {
  return `
    <hr class="section-rule" />
    <section class="sidebar-section">
      <h3>Comparisons</h3>
      <div class="sidebar-stack">
        ${links
          .map(
            (link) => `
              <a class="comparison-link" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">
                <span class="comparison-link__label">${escapeHtml(trimDisplayUrl(link))}</span>
              </a>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderTorrentCard(torrent: EntryPayload["torrents"][number]) {
  const totalSize = torrent.files.reduce((sum, file) => sum + (Number.isFinite(file.length) ? file.length : 0), 0);
  const links = classifyTorrentLinks(torrent);

  return `
    <article class="torrent-card">
      <div class="torrent-card__header">
        <h3>${escapeHtml(torrent.releaseGroup || "Unknown group")}</h3>
        <p>${totalSize > 0 ? `<span>${formatBytes(totalSize)}</span>` : ""}<span>${torrent.files.length} file${torrent.files.length === 1 ? "" : "s"}</span></p>
      </div>

      <div class="torrent-card__badges">
        <span class="pill ${torrent.isBest ? "pill--best" : "pill--alt"}">${torrent.isBest ? "Best" : "Alt"}</span>
        ${torrent.dualAudio ? `<span class="pill pill--tag">Dual Audio</span>` : ""}
        ${torrent.tags.slice(0, 4).map((tag) => `<span class="pill pill--tag">${escapeHtml(tag)}</span>`).join("")}
      </div>

      <div class="torrent-card__actions">
        ${
          links.publicUrl
            ? `<a class="torrent-button" href="${escapeHtml(links.publicUrl)}" target="_blank" rel="noreferrer">${renderCatIcon()} ${escapeHtml(links.publicLabel)}</a>`
            : `<span class="torrent-button torrent-button--muted">No public link</span>`
        }
        ${
          links.hasPrivate
            ? `<span class="torrent-button torrent-button--private" aria-disabled="true">${renderLockIcon()} Private Tracker</span>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderRelationsSection(relations: EntryPayload["entry"]["relations"]) {
  const relationCards = relations
    .filter((relation) => relation.node?.id && relation.node.title)
    .slice(0, 12)
    .map((relation) => {
      const node = relation.node!;
      const title = node.title?.english ?? node.title?.userPreferred ?? String(node.id);
      return `
        <a href="/${node.id}" class="relation-card">
          <div class="relation-card__poster">
            ${
              node.coverImage?.extraLarge
                ? `<img src="${escapeHtml(node.coverImage.extraLarge)}" alt="${escapeHtml(title)} cover" />`
                : `<div class="poster-fallback poster-fallback--small">No art</div>`
            }
          </div>
          <div class="relation-card__body">
            <div class="relation-card__title">${escapeHtml(title)}</div>
            <div class="relation-card__chips">
              ${renderRelationChip(formatCatalogFormat(node.format))}
              ${renderRelationChip(String(node.startDate?.year ?? node.seasonYear ?? "Unknown"))}
              ${renderRelationChip(node.episodes ? `${node.episodes} Episodes` : "Unknown")}
              ${renderRelationChip((node.status ?? "unknown").toLowerCase())}
              ${renderRelationChip(formatRelationType(relation.relationType))}
            </div>
          </div>
        </a>
      `;
    })
    .join("");

  if (!relationCards) {
    return "";
  }

  return `
    <hr class="section-divider" />
    <section class="content-section">
      <h2>Relations</h2>
      <div class="relation-list">
        ${relationCards}
      </div>
    </section>
  `;
}

function renderRelationChip(label: string) {
  return `<span class="relation-chip">${escapeHtml(label)}</span>`;
}

function renderFatal(message: string) {
  return `
    <main class="fatal">
      <div class="fatal__panel">
        <h1>Something slipped.</h1>
        <p>${escapeHtml(message)}</p>
        <a class="comparison-link comparison-link--secondary" href="/">Return home</a>
      </div>
    </main>
  `;
}

function wireCommonUi(status: MirrorStatus, context: "index" | "entry") {
  wireThemeToggle();
  wireSearchDialog(status, context);
}

function wireThemeToggle() {
  const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  toggle?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    window.localStorage.setItem(THEME_KEY, next);
  });
}

function wireSearchDialog(_status: MirrorStatus, context: "index" | "entry") {
  const dialog = document.querySelector<HTMLDivElement>("#search-dialog");
  const trigger = document.querySelector<HTMLButtonElement>("#global-search-trigger");
  const input = document.querySelector<HTMLInputElement>("#dialog-search-input");
  const results = document.querySelector<HTMLDivElement>("#dialog-search-results");
  const meta = document.querySelector<HTMLDivElement>("#dialog-search-meta");

  if (!dialog || !trigger || !input || !results || !meta) {
    return;
  }

  let isOpen = false;

  const closeDialog = () => {
    if (!isOpen) {
      return;
    }
    dialog.hidden = true;
    dialog.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    document.body.classList.remove("is-modal-open");
    isOpen = false;
  };

  const updateResults = async () => {
    const term = input.value.trim();
    if (!term) {
      meta.textContent = "Start typing to search the mirrored catalog.";
      results.innerHTML = "";
      return;
    }

    const catalog = await getCatalog();
    const payload = filterCatalogItems(catalog.items, {
      search: term,
      limit: SEARCH_RESULTS_LIMIT,
      offset: 0,
      sort: "updated",
    });

    meta.textContent = `${payload.pagination.total} match${payload.pagination.total === 1 ? "" : "es"} in the snapshot`;

    results.innerHTML = payload.items.length
      ? payload.items
          .map(
            (item) => `
              <a class="search-result" href="/${item.alId}">
                <div class="search-result__poster">
                  ${
                    item.coverImage.extraLarge
                      ? `<img src="${escapeHtml(item.coverImage.extraLarge)}" alt="${escapeHtml(item.titles.display)} cover" />`
                      : `<div class="poster-fallback poster-fallback--tiny">No art</div>`
                  }
                </div>
                <div class="search-result__body">
                  <div class="search-result__title">${escapeHtml(item.titles.display)}</div>
                  <div class="search-result__meta">${escapeHtml(formatCatalogFormat(item.format))} · ${item.startYear ?? item.seasonYear ?? "Unknown"} · ${item.episodes ?? "?"} ep</div>
                </div>
              </a>
            `,
          )
          .join("")
      : `
          <div class="search-empty">
            No results matched "${escapeHtml(term)}".
          </div>
        `;

    if (context === "entry" && term) {
      results.insertAdjacentHTML(
        "beforeend",
        `
          <a class="search-result search-result--browse" href="/?q=${encodeURIComponent(term)}">
            <div class="search-result__body">
              <div class="search-result__title">Browse all results on the catalog page</div>
              <div class="search-result__meta">Open the full table with this search pre-filled</div>
            </div>
          </a>
        `,
      );
    }

    results.querySelectorAll<HTMLAnchorElement>(".search-result").forEach((link) => {
      link.addEventListener("click", () => {
        closeDialog();
      });
    });
  };

  const openDialog = async () => {
    dialog.hidden = false;
    dialog.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-modal-open");
    isOpen = true;

    if (context === "index") {
      const catalogSearch = document.querySelector<HTMLInputElement>("#catalog-search");
      input.value = catalogSearch?.value ?? "";
    }

    await updateResults();
    window.setTimeout(() => input.focus(), 0);
  };

  trigger.addEventListener("click", () => {
    if (isOpen) {
      closeDialog();
      return;
    }
    void openDialog();
  });

  dialog.querySelectorAll<HTMLElement>("[data-search-close]").forEach((element) => {
    element.addEventListener("click", closeDialog);
  });

  input.addEventListener("input", debounce(() => void updateResults(), 80));

  globalKeydownCleanup?.();
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "/" && !isTypingTarget(event.target) && !isOpen) {
      event.preventDefault();
      void openDialog();
      return;
    }

    if (event.key === "Escape" && isOpen) {
      closeDialog();
    }
  };
  window.addEventListener("keydown", onKeydown);
  globalKeydownCleanup = () => {
    window.removeEventListener("keydown", onKeydown);
  };
}

function wireCatalogActions(body: HTMLElement, mobileList: HTMLElement) {
  const attachRowHandlers = (root: ParentNode) => {
    root.querySelectorAll<HTMLElement>("[data-entry-link]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("[data-menu-toggle]") || target?.closest(".row-menu")) {
          return;
        }
        const href = element.dataset.entryLink;
        if (href) {
          window.location.href = href;
        }
      });

      element.addEventListener("keydown", (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
          return;
        }
        keyboardEvent.preventDefault();
        const href = element.dataset.entryLink;
        if (href) {
          window.location.href = href;
        }
      });
    });
  };

  const closeAllMenus = () => {
    document.querySelectorAll<HTMLElement>(".row-menu").forEach((menu) => {
      menu.hidden = true;
    });
  };

  document.querySelectorAll<HTMLElement>("[data-menu-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const menuId = button.dataset.menuId;
      if (!menuId) {
        return;
      }

      const menu = document.getElementById(menuId);
      if (!menu) {
        return;
      }

      const willOpen = menu.hidden;
      closeAllMenus();
      menu.hidden = !willOpen;
    });
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".row-menu-shell")) {
        return;
      }
      closeAllMenus();
    },
    { once: true },
  );

  attachRowHandlers(body);
  attachRowHandlers(mobileList);
}

function readCatalogStateFromUrl(): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const limit = clampLimit(params.get("limit"));
  const page = clampPage(params.get("page"));

  return {
    search: params.get("q")?.trim() ?? "",
    format: params.get("format")?.trim().toUpperCase() ?? "",
    season: params.get("season")?.trim().toUpperCase() ?? "",
    sort: normalizeSort(params.get("sort")),
    limit,
    offset: (page - 1) * limit,
  };
}

function syncCatalogStateToUrl(state: CatalogState) {
  const params = new URLSearchParams();
  if (state.search) {
    params.set("q", state.search);
  }
  if (state.format) {
    params.set("format", state.format);
  }
  if (state.season) {
    params.set("season", state.season);
  }
  if (state.sort !== "updated") {
    params.set("sort", state.sort);
  }
  if (state.limit !== DEFAULT_PAGE_SIZE) {
    params.set("limit", String(state.limit));
  }
  if (state.offset > 0) {
    params.set("page", String(Math.floor(state.offset / state.limit) + 1));
  }

  const query = params.toString();
  const nextUrl = query ? `/?${query}` : "/";
  window.history.replaceState(null, "", nextUrl);
}

function filterSeason(items: CatalogIndexItem[], seasonFilter: string) {
  if (!seasonFilter) {
    return items;
  }

  return items.filter((item) => toSeasonKey(item.season, item.seasonYear ?? item.startYear) === seasonFilter);
}

function buildSeasonOptions(items: CatalogIndexItem[]) {
  const unique = new Map<string, string>();
  for (const item of items) {
    const key = toSeasonKey(item.season, item.seasonYear ?? item.startYear);
    if (!key) {
      continue;
    }
    unique.set(key, formatSeasonLabel(item.season, item.seasonYear ?? item.startYear));
  }

  return [...unique.entries()]
    .sort((left, right) => compareSeasonKeys(right[0], left[0]))
    .map(([value, label]) => ({ value, label }));
}

function toSeasonKey(season: string | null, year: number | null | undefined) {
  if (!season || !year) {
    return "";
  }
  return `${season.toUpperCase()}:${year}`;
}

function formatSeasonLabel(season: string | null, year: number | null | undefined) {
  if (!season || !year) {
    return "Unknown";
  }
  return `${capitalize(season.toLowerCase())} ${year}`;
}

function compareSeasonKeys(left: string, right: string) {
  const [leftSeason, leftYear] = left.split(":");
  const [rightSeason, rightYear] = right.split(":");
  const yearDiff = Number.parseInt(leftYear, 10) - Number.parseInt(rightYear, 10);
  if (yearDiff !== 0) {
    return yearDiff;
  }
  return seasonOrder(leftSeason) - seasonOrder(rightSeason);
}

function seasonOrder(season: string) {
  switch (season) {
    case "WINTER":
      return 0;
    case "SPRING":
      return 1;
    case "SUMMER":
      return 2;
    case "FALL":
      return 3;
    default:
      return 4;
  }
}

function readGroupSummary(item: CatalogItem): CatalogGroupSummary {
  return (
    groupSummaryCache.get(item.alId) ?? {
      bestLabel: item.bestTorrentCount ? `${item.bestTorrentCount} release${item.bestTorrentCount === 1 ? "" : "s"}` : "None",
      altLabel: item.torrentCount - item.bestTorrentCount > 0 ? `${item.torrentCount - item.bestTorrentCount} release${item.torrentCount - item.bestTorrentCount === 1 ? "" : "s"}` : "None",
    }
  );
}

async function ensureGroupSummaries(items: CatalogItem[]) {
  const tasks = items.map((item) => ensureGroupSummary(item.alId));
  await Promise.all(tasks);
}

async function ensureGroupSummary(alId: number) {
  if (groupSummaryCache.has(alId)) {
    return;
  }

  const existing = groupSummaryInflight.get(alId);
  if (existing) {
    await existing;
    return;
  }

  const inflight = fetchJson<EntryPayload>(`${DATA_ROOT}/entries/${alId}.json`)
    .then((payload) => {
      const best = uniqueReleaseGroups(payload.torrents.filter((torrent) => torrent.isBest));
      const alt = uniqueReleaseGroups(payload.torrents.filter((torrent) => !torrent.isBest));
      groupSummaryCache.set(alId, {
        bestLabel: best.length ? best.join(" / ") : "None",
        altLabel: alt.length ? alt.join(" / ") : "None",
      });
    })
    .finally(() => {
      groupSummaryInflight.delete(alId);
    });

  groupSummaryInflight.set(alId, inflight);
  await inflight;
}

function uniqueReleaseGroups(torrents: EntryPayload["torrents"]) {
  return [...new Set(torrents.map((torrent) => torrent.releaseGroup).filter(Boolean))].slice(0, 2);
}

function classifyTorrentLinks(torrent: EntryPayload["torrents"][number]) {
  const candidates = [torrent.url, torrent.sourceUrl, torrent.groupedUrl, torrent.sourceGroupedUrl].filter(Boolean) as string[];
  const publicUrl = candidates.find((url) => !isPrivateTrackerUrl(url)) ?? null;
  const privateUrl = candidates.find((url) => isPrivateTrackerUrl(url)) ?? null;

  return {
    publicUrl,
    publicLabel: publicUrl ? renderTrackerLabel(publicUrl) : "Public",
    hasPrivate: Boolean(privateUrl || torrent.tracker.toUpperCase() === "AB"),
  };
}

function isPrivateTrackerUrl(url: string) {
  return /\/torrents\.php\?/i.test(url) || /releases\.moe\/torrents\.php/i.test(url);
}

async function getCatalog() {
  if (!cachedCatalogPromise) {
    cachedCatalogPromise = fetchJson<CatalogIndexPayload>(`${DATA_ROOT}/catalog.json`);
  }
  return cachedCatalogPromise;
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

function applySavedTheme() {
  const saved = window.localStorage.getItem(THEME_KEY);
  applyTheme(saved === "light" ? "light" : "dark");
}

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function query<T extends Element>(selector: string) {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing required node: ${selector}`);
  }
  return node;
}

function debounce(callback: () => void | Promise<void>, delayMs: number) {
  let timeoutId: number | null = null;
  return () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      void callback();
    }, delayMs);
  };
}

function clampLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (![15, 30, 60, 90].includes(parsed)) {
    return DEFAULT_PAGE_SIZE;
  }
  return parsed;
}

function clampPage(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeSort(value: string | null) {
  switch (value) {
    case "title":
    case "year":
    case "score":
      return value;
    default:
      return "updated";
  }
}

function formatSeriesLabel(entry: EntryPayload["entry"]) {
  const format = formatCatalogFormat(entry.format);
  const episodes = entry.episodes ?? "?";
  return `${format} (${episodes})`;
}

function formatCatalogFormat(format: string | null | undefined) {
  switch (format) {
    case "TV":
      return "TV Series";
    case "TV_SHORT":
      return "TV Short";
    case "MOVIE":
      return "Movie";
    case "SPECIAL":
      return "Special";
    case "ONA":
      return "ONA";
    case "OVA":
      return "OVA";
    case "MUSIC":
      return "Music";
    default:
      return format ?? "Unknown";
  }
}

function renderTrackerLabel(url: string) {
  if (url.includes("nyaa.si")) {
    return "Nyaa";
  }
  if (url.includes("anidex.info")) {
    return "Anidex";
  }
  return "Public";
}

function trimDisplayUrl(url: string) {
  return url.replace(/^https?:\/\//, "");
}

function formatDate(value: string | null) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "numeric",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Unknown size";
  }

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatRelationType(value: string | null | undefined) {
  if (!value) {
    return "related";
  }
  return value.toLowerCase().replaceAll("_", " ");
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBrandMark() {
  return `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="url(#brand-fill)"/><path d="M22.5 10.5C20.8 8.8 17.8 8 14.9 8C10.8 8 7.7 10.1 7.7 13.5C7.7 17.1 11 18 14.7 18.7C17.5 19.2 19.2 19.8 19.2 21.3C19.2 22.9 17.4 24 14.8 24C12.3 24 10 23.1 8.1 21.3L6 23.7C8.2 26 11.4 27 14.8 27C19.7 27 22.8 24.7 22.8 21.1C22.8 17.5 20.1 16.4 16 15.7C13.1 15.2 11.2 14.8 11.2 13.2C11.2 11.7 12.8 10.7 15.1 10.7C17.2 10.7 19.3 11.3 20.8 12.7L22.5 10.5Z" fill="white"/><defs><linearGradient id="brand-fill" x1="4" y1="3.5" x2="27" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="#C61919"/><stop offset="1" stop-color="#7A0707"/></linearGradient></defs></svg>`;
}

function renderSearchIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 6.5C10 8.433 8.433 10 6.5 10C4.567 10 3 8.433 3 6.5C3 4.567 4.567 3 6.5 3C8.433 3 10 4.567 10 6.5ZM9.30884 10.0159C8.53901 10.6318 7.56251 11 6.5 11C4.01472 11 2 8.98528 2 6.5C2 4.01472 4.01472 2 6.5 2C8.98528 2 11 4.01472 11 6.5C11 7.56251 10.6318 8.53901 10.0159 9.30884L12.8536 12.1464C13.0488 12.3417 13.0488 12.6583 12.8536 12.8536C12.6583 13.0488 12.3417 13.0488 12.1464 12.8536L9.30884 10.0159Z"></path></svg>`;
}

function renderExternalIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>`;
}

function renderLogInIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" x2="3" y1="12" y2="12"></line></svg>`;
}

function renderSunIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.5 0C7.77614 0 8 0.223858 8 0.5V2.5C8 2.77614 7.77614 3 7.5 3C7.22386 3 7 2.77614 7 2.5V0.5C7 0.223858 7.22386 0 7.5 0ZM2.1967 2.1967C2.39196 2.00144 2.70854 2.00144 2.90381 2.1967L4.31802 3.61091C4.51328 3.80617 4.51328 4.12276 4.31802 4.31802C4.12276 4.51328 3.80617 4.51328 3.61091 4.31802L2.1967 2.90381C2.00144 2.70854 2.00144 2.39196 2.1967 2.1967ZM0.5 7C0.223858 7 0 7.22386 0 7.5C0 7.77614 0.223858 8 0.5 8H2.5C2.77614 8 3 7.77614 3 7.5C3 7.22386 2.77614 7 2.5 7H0.5ZM2.1967 12.8033C2.00144 12.608 2.00144 12.2915 2.1967 12.0962L3.61091 10.682C3.80617 10.4867 4.12276 10.4867 4.31802 10.682C4.51328 10.8772 4.51328 11.1938 4.31802 11.3891L2.90381 12.8033C2.70854 12.9986 2.39196 12.9986 2.1967 12.8033ZM12.5 7C12.2239 7 12 7.22386 12 7.5C12 7.77614 12.2239 8 12.5 8H14.5C14.7761 8 15 7.77614 15 7.5C15 7.22386 14.7761 7 14.5 7H12.5ZM10.682 4.31802C10.4867 4.12276 10.4867 3.80617 10.682 3.61091L12.0962 2.1967C12.2915 2.00144 12.608 2.00144 12.8033 2.1967C12.9986 2.39196 12.9986 2.70854 12.8033 2.90381L11.3891 4.31802C11.1938 4.51328 10.8772 4.51328 10.682 4.31802ZM8 12.5C8 12.2239 7.77614 12 7.5 12C7.22386 12 7 12.2239 7 12.5V14.5C7 14.7761 7.22386 15 7.5 15C7.77614 15 8 14.7761 8 14.5V12.5ZM10.682 10.682C10.8772 10.4867 11.1938 10.4867 11.3891 10.682L12.8033 12.0962C12.9986 12.2915 12.9986 12.608 12.8033 12.8033C12.608 12.9986 12.2915 12.9986 12.0962 12.8033L10.682 11.3891C10.4867 11.1938 10.4867 10.8772 10.682 10.682ZM5.5 7.5C5.5 6.39543 6.39543 5.5 7.5 5.5C8.60457 5.5 9.5 6.39543 9.5 7.5C9.5 8.60457 8.60457 9.5 7.5 9.5C6.39543 9.5 5.5 8.60457 5.5 7.5ZM7.5 4.5C5.84315 4.5 4.5 5.84315 4.5 7.5C4.5 9.15685 5.84315 10.5 7.5 10.5C9.15685 10.5 10.5 9.15685 10.5 7.5C10.5 5.84315 9.15685 4.5 7.5 4.5Z"></path></svg>`;
}

function renderMoonIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.54406 0.98184L8.24618 0.941586C8.03275 0.917676 7.90692 1.1655 8.02936 1.34194C8.17013 1.54479 8.29981 1.75592 8.41754 1.97445C8.91878 2.90485 9.20322 3.96932 9.20322 5.10022C9.20322 8.37201 6.82247 11.0878 3.69887 11.6097C3.45736 11.65 3.20988 11.6772 2.96008 11.6906C2.74563 11.702 2.62729 11.9535 2.77721 12.1072C2.84551 12.1773 2.91535 12.2458 2.98667 12.3128L3.05883 12.3795L3.31883 12.6045L3.50684 12.7532L3.62796 12.8433L3.81491 12.9742L3.99079 13.089C4.11175 13.1651 4.23536 13.2375 4.36157 13.3059L4.62496 13.4412L4.88553 13.5607L5.18837 13.6828L5.43169 13.7686C5.56564 13.8128 5.70149 13.8529 5.83857 13.8885C5.94262 13.9155 6.04767 13.9401 6.15405 13.9622C6.27993 13.9883 6.40713 14.0109 6.53544 14.0298L6.85241 14.0685L7.11934 14.0892C7.24637 14.0965 7.37436 14.1002 7.50322 14.1002C11.1483 14.1002 14.1032 11.1453 14.1032 7.50023C14.1032 7.25044 14.0893 7.00389 14.0623 6.76131L14.0255 6.48407C13.991 6.26083 13.9453 6.04129 13.8891 5.82642C13.8213 5.56709 13.7382 5.31398 13.6409 5.06881L13.5279 4.80132L13.4507 4.63542L13.3766 4.48666C13.2178 4.17773 13.0353 3.88295 12.8312 3.60423L12.6782 3.40352L12.4793 3.16432L12.3157 2.98361L12.1961 2.85951L12.0355 2.70246L11.8134 2.50184L11.4925 2.24191L11.2483 2.06498L10.9562 1.87446L10.6346 1.68894L10.3073 1.52378L10.1938 1.47176L9.95488 1.3706L9.67791 1.2669L9.42566 1.1846L9.10075 1.09489L8.83599 1.03486L8.54406 0.98184ZM10.4032 5.30023C10.4032 4.27588 10.2002 3.29829 9.83244 2.40604C11.7623 3.28995 13.1032 5.23862 13.1032 7.50023C13.1032 10.593 10.596 13.1002 7.50322 13.1002C6.63646 13.1002 5.81597 12.9036 5.08355 12.5522C6.5419 12.0941 7.81081 11.2082 8.74322 10.0416C8.87963 10.2284 9.10028 10.3497 9.34928 10.3497C9.76349 10.3497 10.0993 10.0139 10.0993 9.59971C10.0993 9.24256 9.84965 8.94373 9.51535 8.86816C9.57741 8.75165 9.63653 8.63334 9.6926 8.51332C9.88358 8.63163 10.1088 8.69993 10.35 8.69993C11.0403 8.69993 11.6 8.14028 11.6 7.44993C11.6 6.75976 11.0406 6.20024 10.3505 6.19993C10.3853 5.90487 10.4032 5.60464 10.4032 5.30023Z"></path></svg>`;
}

function renderDotsIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.625 7.5C3.625 8.12132 3.12132 8.625 2.5 8.625C1.87868 8.625 1.375 8.12132 1.375 7.5C1.375 6.87868 1.87868 6.375 2.5 6.375C3.12132 6.375 3.625 6.87868 3.625 7.5ZM8.625 7.5C8.625 8.12132 8.12132 8.625 7.5 8.625C6.87868 8.625 6.375 8.12132 6.375 7.5C6.375 6.87868 6.87868 6.375 7.5 6.375C8.12132 6.375 8.625 6.87868 8.625 7.5ZM12.5 8.625C13.1213 8.625 13.625 8.12132 13.625 7.5C13.625 6.87868 13.1213 6.375 12.5 6.375C11.8787 6.375 11.375 6.87868 11.375 7.5C11.375 8.12132 11.8787 8.625 12.5 8.625Z"></path></svg>`;
}

function renderChevronLeftIcon() {
  return `<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.84182 3.13514C9.04327 3.32401 9.05348 3.64042 8.86462 3.84188L5.43521 7.49991L8.86462 11.1579C9.05348 11.3594 9.04327 11.6758 8.84182 11.8647C8.64036 12.0535 8.32394 12.0433 8.13508 11.8419L4.38508 7.84188C4.20477 7.64955 4.20477 7.35027 4.38508 7.15794L8.13508 3.15794C8.32394 2.95648 8.64036 2.94628 8.84182 3.13514Z"></path></svg>`;
}

function renderChevronRightIcon() {
  return `<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z"></path></svg>`;
}

function renderDoubleChevronLeftIcon() {
  return `<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.85355 3.85355C7.04882 3.65829 7.04882 3.34171 6.85355 3.14645C6.65829 2.95118 6.34171 2.95118 6.14645 3.14645L2.14645 7.14645C1.95118 7.34171 1.95118 7.65829 2.14645 7.85355L6.14645 11.8536C6.34171 12.0488 6.65829 12.0488 6.85355 11.8536C7.04882 11.6583 7.04882 11.3417 6.85355 11.1464L3.20711 7.5L6.85355 3.85355ZM12.8536 3.85355C13.0488 3.65829 13.0488 3.34171 12.8536 3.14645C12.6583 2.95118 12.3417 2.95118 12.1464 3.14645L8.14645 7.14645C7.95118 7.34171 7.95118 7.65829 8.14645 7.85355L12.1464 11.8536C12.3417 12.0488 12.6583 12.0488 12.8536 11.8536C13.0488 11.6583 13.0488 11.3417 12.8536 11.1464L9.20711 7.5L12.8536 3.85355Z"></path></svg>`;
}

function renderDoubleChevronRightIcon() {
  return `<svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.14645 11.1464C1.95118 11.3417 1.95118 11.6583 2.14645 11.8536C2.34171 12.0488 2.65829 12.0488 2.85355 11.8536L6.85355 7.85355C7.04882 7.65829 7.04882 7.34171 6.85355 7.14645L2.85355 3.14645C2.65829 2.95118 2.34171 2.95118 2.14645 3.14645C1.95118 3.34171 1.95118 3.65829 2.14645 3.85355L5.79289 7.5L2.14645 11.1464ZM8.14645 11.1464C7.95118 11.3417 7.95118 11.6583 8.14645 11.8536C8.34171 12.0488 8.65829 12.0488 8.85355 11.8536L12.8536 7.85355C13.0488 7.65829 13.0488 7.34171 12.8536 7.14645L8.85355 3.14645C8.65829 2.95118 8.34171 2.95118 8.14645 3.14645C7.95118 3.34171 7.95118 3.65829 8.14645 3.85355L11.7929 7.5L8.14645 11.1464Z"></path></svg>`;
}

function renderCloseIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`;
}

function renderLockIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
}

function renderCatIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 8.8 6H4.5A2.5 2.5 0 0 0 2 8.5v4.8A8.7 8.7 0 0 0 10.7 22h2.6A8.7 8.7 0 0 0 22 13.3V8.5A2.5 2.5 0 0 0 19.5 6h-4.3L12 2Zm-3 9.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm-3 5c-1.3 0-2.4-.5-3.3-1.4l1.1-1.1c.6.6 1.3.9 2.2.9s1.6-.3 2.2-.9l1.1 1.1c-.9.9-2 1.4-3.3 1.4Z"></path></svg>`;
}

function renderCalendarIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect width="18" height="18" x="3" y="4" rx="2"></rect><path d="M3 10h18"></path></svg>`;
}

function renderCalendarPlusIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"></path><path d="M16 2v4"></path><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"></path><path d="M3 10h18"></path><path d="M16 19h6"></path><path d="M19 16v6"></path></svg>`;
}

function renderCalendarUpIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 18 4-4 4 4"></path><path d="M16 2v4"></path><path d="M18 22v-8"></path><path d="M21 11.343V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9"></path><path d="M3 10h18"></path><path d="M8 2v4"></path></svg>`;
}

function renderFormatIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"></rect><line x1="8" x2="16" y1="21" y2="21"></line><line x1="12" x2="12" y1="17" y2="21"></line></svg>`;
}
