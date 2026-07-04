import "./styles.css";
import { renderEntryContent, renderEntryError, renderEntryNotFound } from "./entry-page";
import {
  capitalize,
  formatCatalogFormat,
  formatDate,
} from "./format";
import { debounce, escapeHtml, isTypingTarget, query } from "./html";
import {
  renderChevronLeftIcon,
  renderChevronRightIcon,
  renderCloseIcon,
  renderDotsIcon,
  renderDoubleChevronLeftIcon,
  renderDoubleChevronRightIcon,
  renderExternalIcon,
  renderGithubIcon,
  renderLogInIcon,
  renderMixerIcon,
  renderMoonIcon,
  renderSearchIcon,
  renderSunIcon,
} from "./icons";
import {
  filterCatalogItems,
  type CatalogIndexItem,
  type CatalogIndexPayload,
  type CatalogItem,
  type CatalogPayload,
  type EntryPayload,
  type MirrorStatus,
  type SheetWorkbookPayload,
  type SheetWorkbookSheet,
} from "../../shared/mirror";

const DATA_ROOT = "/mirror-data";
const COMPACT_LAYOUT_MEDIA_QUERY = "(max-width: 760px)";
const DEFAULT_PAGE_SIZE = 30;
const SEARCH_RESULTS_LIMIT = 10;
const THEME_KEY = "seadex-mirror-theme";
const UPSTREAM_SITE_URL = "https://releases.moe/";
const UPSTREAM_ABOUT_URL = "https://releases.moe/about/";
const UPSTREAM_SHEET_URL = "https://sheet.releases.moe/";
const DEVELOPER_GITHUB_URL = "https://github.com/EithonX";
const DEVELOPER_GITHUB_USERNAME = "EithonX";
const DEVELOPER_GITHUB_AVATAR_URL = "https://github.com/EithonX.png";

type RouteContext =
  | { kind: "index" }
  | { kind: "about" }
  | { kind: "sheet" }
  | { kind: "entry"; alId: number };

type CatalogState = {
  search: string;
  format: string;
  season: string;
  year: string;
  sort: string;
  limit: number;
  offset: number;
};

type SheetWorkbookState = {
  tab: string;
  query: string;
};

type EntryPayloadResult =
  | { ok: true; payload: EntryPayload }
  | { ok: false; error: unknown };

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found.");
}
const appRoot = app;

let cachedCatalogPromise: Promise<CatalogIndexPayload> | null = null;
let cachedSheetWorkbookPromise: Promise<SheetWorkbookPayload> | null = null;
let cachedSheetRendererPromise: Promise<typeof import("./sheet-workbook")> | null = null;
const entryPayloadCache = new Map<number, Promise<EntryPayload>>();
const entryPrefetchAttempts = new Set<number>();
let globalKeydownCleanup: (() => void) | null = null;
const wiredCatalogActionRoots = new WeakSet<HTMLElement>();
let catalogMenuOutsideClickWired = false;

applySavedTheme();

boot().catch((error) => {
  appRoot.innerHTML = renderFatal(error);
});

class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

class HttpStatusError extends FetchJsonError {
  constructor(
    url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(body || `Request failed with ${status}`, url);
  }
}

class MirrorDataMissingError extends FetchJsonError {
  constructor(url: string) {
    super(`Mirror data is missing at ${url}. Run \`npm run data:build\` before previewing the site.`, url);
  }
}

async function boot() {
  const route = parseRoute(window.location.pathname);
  const statusPromise = fetchJson<MirrorStatus>(`${DATA_ROOT}/status.json`);

  if (route.kind === "entry") {
    const entryLoad = loadEntryPayload(route.alId);
    const status = await statusPromise;
    await renderEntry(status, route.alId, entryLoad.result, entryLoad.url);
    return;
  }

  const status = await statusPromise;

  switch (route.kind) {
    case "index":
      setDocumentMeta("SeaDex Mirror");
      await renderCatalog(status);
      return;
    case "about":
      setDocumentMeta("About | SeaDex Mirror");
      renderAbout(status);
      return;
    case "sheet":
      setDocumentMeta("Sheet | SeaDex Mirror");
      await renderSheet(status);
      return;
  }
}

function loadEntryPayload(alId: number) {
  const url = getEntryDataUrl(alId);
  const result = loadCachedEntryPayload(alId).then(
    (payload): EntryPayloadResult => ({ ok: true, payload }),
    (error: unknown): EntryPayloadResult => ({ ok: false, error }),
  );

  return { url, result };
}

function loadCachedEntryPayload(alId: number) {
  const cached = entryPayloadCache.get(alId);
  if (cached) {
    return cached;
  }

  const promise = fetchJson<EntryPayload>(getEntryDataUrl(alId)).catch((error: unknown) => {
    entryPayloadCache.delete(alId);
    throw error;
  });
  entryPayloadCache.set(alId, promise);
  return promise;
}

function prefetchEntryPayload(alId: number) {
  if (entryPrefetchAttempts.has(alId)) {
    return;
  }

  entryPrefetchAttempts.add(alId);
  loadCachedEntryPayload(alId).catch((error: unknown) => {
    console.debug("Entry prefetch failed.", { alId, error });
  });
}

function getEntryDataUrl(alId: number) {
  return `${DATA_ROOT}/entries/${alId}.json`;
}

function parseRoute(pathname: string): RouteContext {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    return { kind: "index" };
  }

  if (normalized === "/about") {
    return { kind: "about" };
  }

  if (normalized === "/sheet") {
    return { kind: "sheet" };
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
  const yearOptions = buildYearOptions(catalog.items);

  appRoot.innerHTML = renderPageFrame(
    status,
    "index",
    `
      <main class="page page--catalog">
        <section class="catalog-page">
          <div class="catalog-toolbar">
            <div class="catalog-toolbar__group catalog-toolbar__group--search">
              <label class="control-shell control-shell--search" for="catalog-search">
                ${renderSearchIcon()}
                <input id="catalog-search" class="control-input" type="search" placeholder="Filter anime..." value="${escapeHtml(state.search)}" autocomplete="off" />
              </label>
              <button id="mobile-filter-trigger" class="mobile-filter-button" type="button" aria-expanded="false">
                ${renderMixerIcon()}
                <span>Filters</span>
                <span id="mobile-filter-badge" class="mobile-filter-badge" hidden></span>
              </button>
            </div>
            <div class="catalog-toolbar__filters" id="catalog-toolbar-filters">
              <div class="catalog-toolbar__filters-inner">
                <div class="catalog-toolbar__group catalog-toolbar__group--grow">
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
                  <label class="control-select">
                    <span>Year</span>
                    <select id="catalog-year">
                      <option value="">All years</option>
                      ${yearOptions
                        .map(
                          (option) =>
                            `<option value="${escapeHtml(option.value)}"${option.value === state.year ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
                        )
                        .join("")}
                    </select>
                  </label>
                  <button id="catalog-reset" class="catalog-reset-button" type="button" title="Clear active filters" disabled>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    <span>Clear filters</span>
                  </button>
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
            <span>Updated ${formatDate(status.sync.lastRebuildFinishedAt)}</span>
          </footer>
        </section>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "index");
  wireFilterDrawer();

  const searchInput = query<HTMLInputElement>("#catalog-search");
  const formatSelect = query<HTMLSelectElement>("#catalog-format");
  const seasonSelect = query<HTMLSelectElement>("#catalog-season");
  const yearSelect = query<HTMLSelectElement>("#catalog-year");
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
  const compactLayoutMedia = window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY);
  const resetButton = document.getElementById("catalog-reset") as HTMLButtonElement | null;

  let currentPayload: CatalogPayload | null = null;

  const renderPage = () => {
    state.search = searchInput.value.trim();
    state.format = formatSelect.value;
    state.season = seasonSelect.value;
    state.year = yearSelect.value;
    state.sort = sortSelect.value;
    state.limit = Number.parseInt(limitSelect.value, 10) || DEFAULT_PAGE_SIZE;

    // Update mobile filter badge
    const activeCount = (state.format ? 1 : 0) + (state.season ? 1 : 0) + (state.year ? 1 : 0);
    const badge = document.getElementById("mobile-filter-badge");
    if (badge) {
      if (activeCount > 0) {
        badge.textContent = String(activeCount);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }

    // Update Reset button state
    if (resetButton) {
      resetButton.disabled = activeCount === 0;
    }

    const filteredItems = filterSeasonAndYear(catalog.items, state.season, state.year);
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
    const useMobileLayout = compactLayoutMedia.matches;

    if (currentPayload.items.length === 0) {
      if (useMobileLayout) {
        body.innerHTML = "";
        mobileList.innerHTML = `
          <div class="catalog-empty catalog-empty--mobile">
            No mirrored entries matched that filter.
          </div>
        `;
      } else {
        body.innerHTML = `
          <tr>
            <td class="catalog-empty" colspan="8">No mirrored entries matched that filter.</td>
          </tr>
        `;
        mobileList.innerHTML = "";
      }
      summary.textContent = "0 row(s) loaded.";
      indicator.textContent = "Page 0 of 0";
      firstButton.disabled = true;
      prevButton.disabled = true;
      nextButton.disabled = true;
      lastButton.disabled = true;
      return;
    }

    if (useMobileLayout) {
      body.innerHTML = "";
      mobileList.innerHTML = currentPayload.items.map(renderCatalogMobileCard).join("");
    } else {
      body.innerHTML = currentPayload.items.map(renderCatalogRow).join("");
      mobileList.innerHTML = "";
    }
    summary.textContent = `${currentPayload.items.length} row(s) loaded.`;
    indicator.textContent = `Page ${currentPage} of ${totalPages}`;

    firstButton.disabled = currentPage <= 1;
    prevButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage >= totalPages;
    lastButton.disabled = currentPage >= totalPages;

    wireCatalogActions(body, mobileList);
  };

  const scheduleRender = createRenderScheduler(renderPage);

  const resetAndRender = () => {
    state.offset = 0;
    scheduleRender();
  };

  const debouncedRender = debounce(resetAndRender, 120);

  searchInput.addEventListener("input", debouncedRender);
  formatSelect.addEventListener("change", resetAndRender);
  seasonSelect.addEventListener("change", resetAndRender);
  yearSelect.addEventListener("change", resetAndRender);
  sortSelect.addEventListener("change", resetAndRender);
  limitSelect.addEventListener("change", resetAndRender);
  bindMediaQueryChange(compactLayoutMedia, scheduleRender);

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      formatSelect.value = "";
      seasonSelect.value = "";
      yearSelect.value = "";
      formatSelect.dispatchEvent(new Event("change"));
      seasonSelect.dispatchEvent(new Event("change"));
      yearSelect.dispatchEvent(new Event("change"));
    });
  }

  firstButton.addEventListener("click", () => {
    state.offset = 0;
    scheduleRender();
  });

  prevButton.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    scheduleRender();
  });

  nextButton.addEventListener("click", () => {
    if (!currentPayload?.pagination.nextOffset && currentPayload?.pagination.nextOffset !== 0) {
      return;
    }
    state.offset = currentPayload.pagination.nextOffset ?? state.offset;
    scheduleRender();
  });

  lastButton.addEventListener("click", () => {
    if (!currentPayload) {
      return;
    }
    const totalPages = Math.max(1, Math.ceil(currentPayload.pagination.total / state.limit));
    state.offset = (totalPages - 1) * state.limit;
    scheduleRender();
  });

  renderPage();
}

async function renderSheet(status: MirrorStatus) {
  document.body.classList.add("is-sheet-page");
  const sheetRendererPromise = loadSheetRenderer();
  const workbookPromise = loadSheetWorkbookPayload();
  const [sheetRenderer, workbook] = await Promise.all([sheetRendererPromise, workbookPromise]);
  const state = readSheetWorkbookStateFromUrl(workbook, sheetRenderer.resolveSheetWorkbookSheet);
  let activeSheet = sheetRenderer.resolveSheetWorkbookSheet(workbook, state.tab);
  const creditLabel = workbook.credit?.label ?? "Original sheet by SeaSmoke#0002";
  const creditUrl = workbook.credit?.url ?? null;

  appRoot.innerHTML = renderPageFrame(
    status,
    "sheet",
    `
      <main class="page page--sheet">
        <style id="sheet-workbook-inline-styles">${sheetRenderer.renderSheetWorkbookStyleRules(workbook.styles)}</style>
        <section class="sheet-workbook">
          <div class="sheet-workbook__panel sheet-workbook__masthead">
            <div class="sheet-workbook__title-row">
              <h1 class="sheet-workbook__title">SeaDex Sheets <span class="sheet-workbook__badge">Mirror</span></h1>
            </div>
            <div class="sheet-workbook__masthead-actions">
              <a class="sheet-workbook__upstream" href="${escapeHtml(UPSTREAM_SHEET_URL)}" target="_blank" rel="noreferrer">
                ${renderExternalIcon()}
                Open upstream
              </a>
              <span class="sheet-workbook__credit">
                ${creditUrl
                    ? `<a href="${escapeHtml(creditUrl)}" target="_blank" rel="noreferrer">${escapeHtml(creditLabel)}</a>`
                    : `<strong>${escapeHtml(creditLabel)}</strong>`
                }
              </span>
            </div>
          </div>

          <div class="sheet-workbook__panel sheet-workbook__toolbar">
            <div class="sheet-workbook__tabs" role="tablist" aria-label="Workbook tabs">
              ${workbook.sheets
                .map(
                  (sheet) => `
                    <button
                      class="sheet-workbook__tab${sheet.slug === activeSheet.slug ? " is-active" : ""}"
                      type="button"
                      role="tab"
                      aria-selected="${sheet.slug === activeSheet.slug ? "true" : "false"}"
                      data-sheet-tab="${escapeHtml(sheet.slug)}"
                      ${sheet.tabColor ? `style="--sheet-tab-accent:${escapeHtml(sheet.tabColor)}"` : ""}
                    >
                      <span class="sheet-workbook__tab-dot"></span>
                      ${escapeHtml(sheet.name)}
                    </button>
                  `,
                )
                .join("")}
            </div>

            <div class="sheet-workbook__toolbar-side">
              <label class="sheet-workbook__search" for="sheet-workbook-query">
                ${renderSearchIcon()}
                <input
                  id="sheet-workbook-query"
                  type="search"
                  value="${escapeHtml(state.query)}"
                  placeholder="Find in current tab..."
                  autocomplete="off"
                />
              </label>
            </div>
          </div>

          <section id="sheet-workbook-grid" class="sheet-workbook__grid" aria-live="polite"></section>
        </section>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "sheet");

  const grid = query<HTMLElement>("#sheet-workbook-grid");
  const queryInput = query<HTMLInputElement>("#sheet-workbook-query");
  const tabButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-sheet-tab]")];

  const renderWorkbook = () => {
    activeSheet = sheetRenderer.resolveSheetWorkbookSheet(workbook, state.tab);
    const rendered = sheetRenderer.renderSheetWorkbookGrid(workbook, activeSheet, state.query);

    grid.innerHTML = rendered.html;

    for (const button of tabButtons) {
      const isActive = button.dataset.sheetTab === activeSheet.slug;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    }

    syncSheetWorkbookStateToUrl(state);
  };

  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.sheetTab;
      if (!nextTab || nextTab === state.tab) {
        return;
      }
      state.tab = nextTab;
      renderWorkbook();
    });
  }

  queryInput.addEventListener(
    "input",
    debounce(() => {
      state.query = queryInput.value.trim();
      renderWorkbook();
    }, 80),
  );

  renderWorkbook();
}

function renderAbout(status: MirrorStatus) {
  const rebuiltLabel = status.sync.lastRebuildFinishedAt ? formatDate(status.sync.lastRebuildFinishedAt) : "Unknown";

  appRoot.innerHTML = renderPageFrame(
    status,
    "about",
    `
      <main class="page page--about">
        <section class="about-page">
          <article class="about-essay">
            <div class="about-hero">
              <p class="sheet-kicker">About</p>
              <h1>SeaDex Mirror</h1>
              <p class="about-lead">
                This is a backup mirror of releases.moe in case the original site is down, slow, or temporarily unavailable. The goal is to keep the public data readable and easy to access, not to replace the upstream project.
              </p>
              <div class="about-pill-row">
                <span class="about-pill">Backup mirror</span>
                <span class="about-pill">Fast access</span>
                <span class="about-pill">No trackers</span>
                <span class="about-pill">Upstream links</span>
              </div>
            </div>

            <div class="about-stats">
              <div class="about-stat">
                <span class="about-stat__label">Mirrored entries</span>
                <strong>${status.counts.entries.toLocaleString()}</strong>
              </div>
              <div class="about-stat">
                <span class="about-stat__label">Torrent rows</span>
                <strong>${status.counts.torrents.toLocaleString()}</strong>
              </div>
              <div class="about-stat">
                <span class="about-stat__label">Last rebuild</span>
                <strong>${escapeHtml(rebuiltLabel)}</strong>
              </div>
            </div>

            <hr class="section-divider" />

            <div class="about-list">
              <div class="about-block">
                <h2>What this mirror is for</h2>
                <p>Recently I faced issues with the SeaDex website because the AniList API was down. So I made this mirror website. This mirror is here as a backup in case the original site is unavailable. It is meant to give you another way to read the same public SeaDex information when you need it.</p>
              </div>
              <div class="about-block">
                <h2>Who to credit</h2>
                <p>SeaDex a.k.a releases.moe is the original source. The recommendations, notes, and torrent information come from them. This mirror only republishes public-facing data with proper credits. Again, kudos to them.</p>
              </div>
              <div class="about-block">
                <h2>Maintainer</h2>
                <div id="github-maintainer-shell">
                  ${renderMaintainerProfileCard({
                    avatarUrl: DEVELOPER_GITHUB_AVATAR_URL,
                    username: DEVELOPER_GITHUB_USERNAME,
                    bio: "Keeps this mirror online and updated.",
                    profileUrl: DEVELOPER_GITHUB_URL,
                  })}
                </div>
              </div>
              <div class="about-block">
                <h2>Upstream pages</h2>
                <p>If you want the original site or its own About page, use the links below.</p>
                <div class="about-card__actions">
                  <a class="comparison-link comparison-link--secondary" href="${escapeHtml(UPSTREAM_ABOUT_URL)}" target="_blank" rel="noreferrer">
                    <span>${renderExternalIcon()}</span>
                    <span>SeaDex about</span>
                  </a>
                  <a class="comparison-link comparison-link--secondary" href="${escapeHtml(UPSTREAM_SITE_URL)}" target="_blank" rel="noreferrer">
                    <span>${renderLogInIcon()}</span>
                    <span>releases.moe</span>
                  </a>
                </div>
              </div>
            </div>
          </article>
        </section>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "about");

  const maintainerShell = document.getElementById("github-maintainer-shell");
  if (maintainerShell) {
    fetch(`https://api.github.com/users/${encodeURIComponent(DEVELOPER_GITHUB_USERNAME)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`GitHub profile fetch failed with ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        maintainerShell.innerHTML = renderMaintainerProfileCard({
          avatarUrl: typeof data.avatar_url === "string" && data.avatar_url ? data.avatar_url : DEVELOPER_GITHUB_AVATAR_URL,
          username: typeof data.login === "string" && data.login ? data.login : DEVELOPER_GITHUB_USERNAME,
          bio: typeof data.bio === "string" && data.bio.trim() ? data.bio.trim() : "Keeps this mirror online and updated.",
          profileUrl: typeof data.html_url === "string" && data.html_url ? data.html_url : DEVELOPER_GITHUB_URL,
        });
      })
      .catch(() => {
        maintainerShell.innerHTML = renderMaintainerProfileCard({
          avatarUrl: DEVELOPER_GITHUB_AVATAR_URL,
          username: DEVELOPER_GITHUB_USERNAME,
          bio: "Keeps this mirror online and updated.",
          profileUrl: DEVELOPER_GITHUB_URL,
        });
      });
  }
}

function renderMaintainerProfileCard(input: {
  avatarUrl: string;
  username: string;
  bio: string;
  profileUrl: string;
}) {
  return `
    <div class="github-profile-card">
      <div class="github-profile-card__main">
        <img class="github-profile-card__avatar" src="${escapeHtml(input.avatarUrl)}" alt="${escapeHtml(input.username)} avatar" />
        <div class="github-profile-card__info">
          <strong>@${escapeHtml(input.username)}</strong>
          <p>${escapeHtml(input.bio)}</p>
        </div>
      </div>
      <a class="github-profile-card__footer" href="${escapeHtml(input.profileUrl)}" target="_blank" rel="noreferrer">
        <span class="github-profile-card__footer-icon">${renderGithubIcon()}</span>
        <span class="github-profile-card__footer-text">github.com/${escapeHtml(input.username)}</span>
      </a>
    </div>
  `;
}

async function renderEntry(
  status: MirrorStatus,
  alId: number,
  entryResultPromise: Promise<EntryPayloadResult>,
  entryUrl: string,
) {
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

  try {
    const entryResult = await entryResultPromise;
    if (!entryResult.ok) {
      throw entryResult.error;
    }

    const payload = entryResult.payload;
    const entry = payload.entry;
    setDocumentMeta(`${entry.titles.display} | SeaDex Mirror`);

    appRoot.innerHTML = renderPageFrame(
      status,
      "entry",
      `
        ${renderEntryContent(payload, status)}
        ${renderSearchDialog()}
      `,
    );

    wireCommonUi(status, "entry");
  } catch (error) {
    if (isNotFoundForUrl(error, entryUrl)) {
      appRoot.innerHTML = renderPageFrame(
        status,
        "entry",
        `
          ${renderEntryNotFound(alId)}
          ${renderSearchDialog()}
        `,
      );
      wireCommonUi(status, "entry");
      setDocumentMeta(`Entry Not Found | SeaDex Mirror`);
      return;
    }

    console.error("Failed to load entry:", error);
    let displayMessage = error instanceof Error ? error.message : String(error);
    if (isMirrorDataMissingError(error)) {
      displayMessage = "The detail for this anime entry could not be loaded because it is currently undergoing maintenance. Please check back shortly.";
    } else {
      displayMessage = "A temporary network issue occurred. Please refresh or try again later.";
    }

    appRoot.innerHTML = renderPageFrame(
      status,
      "entry",
      `
        ${renderEntryError(alId, displayMessage)}
        ${renderSearchDialog()}
      `,
    );
    wireCommonUi(status, "entry");
    setDocumentMeta(`Error | SeaDex Mirror`);
  }
}

function renderPageFrame(status: MirrorStatus, context: "index" | "entry" | "about" | "sheet", content: string) {
  return `
    ${renderShell(status, context)}
    ${content}
  `;
}

function renderShell(status: MirrorStatus, context: "index" | "entry" | "about" | "sheet") {
  const originalSiteUrl = normalizeExternalUrl(status.mirror.originalSite || UPSTREAM_SITE_URL);
  return `
    <header class="site-header">
      <div class="site-header__inner">
        <div class="site-header__brand">
          <a href="/" class="brand-link" aria-label="SeaDex mirror home">
            <span class="brand-mark"><img src="/favicon.png" alt="SeaDex logo" /></span>
            <span class="brand-label">SeaDex</span>
          </a>
          <nav class="site-nav" aria-label="Primary navigation">
            <a href="/about"${context === "about" ? ` aria-current="page"` : ""}>About</a>
            <a href="${escapeHtml(DEVELOPER_GITHUB_URL)}" target="_blank" rel="noreferrer">GitHub</a>
            <a href="/sheet"${context === "sheet" ? ` aria-current="page"` : ""}>Sheet</a>
          </nav>
        </div>

        <button id="global-search-trigger" class="header-search" type="button" aria-haspopup="dialog" aria-controls="search-dialog" aria-expanded="false">
          ${renderSearchIcon()}
          <span>Search anime...</span>
        </button>

        <div class="site-header__actions">
          <button id="theme-toggle" class="ghost-icon-button" type="button" aria-label="Toggle theme">
            <span class="theme-sun">${renderSunIcon()}</span>
            <span class="theme-moon">${renderMoonIcon()}</span>
          </button>
        </div>
      </div>
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
  const posterSrc = item.coverImage?.extraLarge ?? "";
  const menuId = `row-menu-${item.alId}`;

  return `
    <tr class="catalog-row" data-entry-link="/${item.alId}" data-entry-id="${item.alId}" tabindex="0">
      <td>
        <div class="catalog-title">
          ${posterSrc ? `<img src="${escapeHtml(posterSrc)}" class="catalog-title__poster" alt="" loading="lazy" />` : `<div class="catalog-title__poster catalog-title__poster--fallback"></div>`}
          <div class="catalog-title__text-group">
            <span class="catalog-title__text">${escapeHtml(item.titles.display)}</span>
            ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
          </div>
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
          <button class="row-menu-toggle" type="button" aria-label="Open row menu" aria-expanded="false" aria-controls="${menuId}" data-menu-toggle data-menu-id="${menuId}">
            ${renderDotsIcon()}
          </button>
          <div id="${menuId}" class="row-menu" role="menu" hidden>
            <a href="/${item.alId}" role="menuitem">Open entry</a>
            <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer" role="menuitem">AniList</a>
            ${
              item.comparisonLinks[0]
                ? `<a href="${escapeHtml(item.comparisonLinks[0])}" target="_blank" rel="noreferrer" role="menuitem">First comparison</a>`
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
  const posterSrc = item.coverImage?.extraLarge ?? "";
  const menuId = `mobile-row-menu-${item.alId}`;

  return `
    <article class="catalog-mobile-item" data-entry-link="/${item.alId}" data-entry-id="${item.alId}" tabindex="0">
      <div class="catalog-mobile-item__poster">
        ${posterSrc ? `<img src="${escapeHtml(posterSrc)}" alt="" loading="lazy" />` : `<div class="catalog-mobile-item__poster-fallback"></div>`}
      </div>
      
      <div class="catalog-mobile-item__title">
        <span>${escapeHtml(item.titles.display)}</span>
        ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
      </div>
      
      <div class="catalog-mobile-item__action">
        <div class="row-menu-shell">
          <button class="row-menu-toggle" type="button" aria-label="Open row menu" aria-expanded="false" aria-controls="${menuId}" data-menu-toggle data-menu-id="${menuId}">
            ${renderDotsIcon()}
          </button>
          <div id="${menuId}" class="row-menu row-menu--mobile" role="menu" hidden>
            <a href="/${item.alId}" role="menuitem">Open entry</a>
            <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer" role="menuitem">AniList</a>
            ${
              item.comparisonLinks[0]
                ? `<a href="${escapeHtml(item.comparisonLinks[0])}" target="_blank" rel="noreferrer" role="menuitem">First comparison</a>`
                : ""
            }
          </div>
        </div>
      </div>
      
      <div class="catalog-mobile-item__meta-row">
        <div class="catalog-mobile-item__meta">
          <span>${escapeHtml(formatCatalogFormat(item.format))}</span>
          <span>${year}</span>
          <span>${item.episodes ?? "?"} ep</span>
        </div>
        <div class="catalog-mobile-item__date">${formatDate(item.sourceUpdatedAt)}</div>
      </div>
      
      <div class="catalog-mobile-item__groups">
        ${groups.bestLabel ? `
        <div class="catalog-mobile-item__group">
          <span class="catalog-mobile-item__group-label">Best</span>
          <span class="catalog-mobile-item__group-value">${escapeHtml(groups.bestLabel)}</span>
        </div>` : ""}
        
        ${groups.altLabel ? `
        <div class="catalog-mobile-item__group">
          <span class="catalog-mobile-item__group-label">Alt</span>
          <span class="catalog-mobile-item__group-value">${escapeHtml(groups.altLabel)}</span>
        </div>` : ""}
      </div>
    </article>
  `;
}

function renderFatal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  let displayMessage = message;
  if (isMirrorDataMissingError(error)) {
    displayMessage = "The mirror database is currently undergoing maintenance. Please check back shortly.";
  }

  return `
    <main class="fatal">
      <div class="fatal__panel">
        <h1>Something slipped.</h1>
        <p>${escapeHtml(displayMessage)}</p>
        <a class="comparison-link comparison-link--secondary" href="/">Return home</a>
      </div>
    </main>
  `;
}

function wireCommonUi(status: MirrorStatus, context: "index" | "entry" | "about" | "sheet") {
  wireThemeToggle();
  wireSearchDialog(status, context);
  wireEntryRetry();
  if (context === "index" || context === "sheet") {
    initializeCustomDropdowns();
  }
}

function wireEntryRetry() {
  document.querySelector<HTMLButtonElement>("[data-entry-retry]")?.addEventListener("click", () => {
    window.location.reload();
  });
}

function wireThemeToggle() {
  const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  toggle?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    saveTheme(next);
  });
}

function wireSearchDialog(_status: MirrorStatus, context: "index" | "entry" | "about" | "sheet") {
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
    closeAllCustomDropdowns();
    dialog.hidden = false;
    dialog.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-modal-open");
    isOpen = true;

    if (context === "index") {
      input.value = document.querySelector<HTMLInputElement>("#catalog-search")?.value ?? "";
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
    const isSearchShortcut =
      (event.key === "/" && !isTypingTarget(event.target)) ||
      ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey));

    if (isSearchShortcut && !isOpen) {
      event.preventDefault();
      void openDialog();
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeDialog();
    }
  };
  window.addEventListener("keydown", onKeydown);
  globalKeydownCleanup = () => {
    window.removeEventListener("keydown", onKeydown);
  };
}

function wireCatalogActions(body: HTMLElement, mobileList: HTMLElement) {
  attachCatalogActionRoot(body);
  if (mobileList !== body) {
    attachCatalogActionRoot(mobileList);
  }

  if (!catalogMenuOutsideClickWired) {
    document.addEventListener("click", closeCatalogMenusOnOutsideClick);
    catalogMenuOutsideClickWired = true;
  }
}

function attachCatalogActionRoot(root: HTMLElement) {
  if (wiredCatalogActionRoots.has(root)) {
    return;
  }

  root.addEventListener("click", handleCatalogRootClick);
  root.addEventListener("auxclick", handleCatalogRootAuxClick);
  root.addEventListener("keydown", handleCatalogRootKeydown);
  root.addEventListener("pointerenter", handleCatalogEntryIntent, true);
  root.addEventListener("focusin", handleCatalogEntryIntent);
  root.addEventListener("pointerdown", handleCatalogEntryPointerDown);
  wiredCatalogActionRoots.add(root);
}

function handleCatalogRootClick(event: MouseEvent) {
  const target = getCatalogEventTarget(event);
  if (!target) {
    return;
  }

  const menuToggle = getCatalogMenuToggle(target);
  if (menuToggle) {
    event.preventDefault();
    toggleCatalogRowMenu(menuToggle);
    return;
  }

  const entry = getCatalogEntryFromTarget(target);
  if (!entry || shouldIgnoreCatalogEntryTarget(target, entry) || event.defaultPrevented || event.button !== 0) {
    return;
  }

  const href = entry.dataset.entryLink;
  if (!href) {
    return;
  }

  event.preventDefault();
  openCatalogEntry(href, event);
}

function handleCatalogRootAuxClick(event: MouseEvent) {
  if (event.button !== 1) {
    return;
  }

  const target = getCatalogEventTarget(event);
  if (!target) {
    return;
  }

  const entry = getCatalogEntryFromTarget(target);
  if (!entry || shouldIgnoreCatalogEntryTarget(target, entry) || event.defaultPrevented) {
    return;
  }

  const href = entry.dataset.entryLink;
  if (!href) {
    return;
  }

  event.preventDefault();
  openCatalogEntry(href, event);
}

function handleCatalogRootKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const target = getCatalogEventTarget(event);
  if (!target) {
    return;
  }

  const entry = getCatalogEntryFromTarget(target);
  if (!entry || shouldIgnoreCatalogEntryTarget(target, entry)) {
    return;
  }

  const href = entry.dataset.entryLink;
  if (!href) {
    return;
  }

  event.preventDefault();
  openCatalogEntry(href, event);
}

function handleCatalogEntryIntent(event: Event) {
  const target = getCatalogEventTarget(event);
  if (!target) {
    return;
  }

  prefetchCatalogEntryFromTarget(target);
}

function handleCatalogEntryPointerDown(event: PointerEvent) {
  if (event.pointerType !== "touch") {
    return;
  }

  handleCatalogEntryIntent(event);
}

function prefetchCatalogEntryFromTarget(target: Element) {
  const entry = getCatalogEntryFromTarget(target);
  if (!entry) {
    return;
  }

  const alId = Number(entry.dataset.entryId);
  if (Number.isFinite(alId)) {
    prefetchEntryPayload(alId);
  }
}

function getCatalogEventTarget(event: Event) {
  return event.target instanceof Element ? event.target : null;
}

function getCatalogEntryFromTarget(target: Element) {
  return target.closest<HTMLElement>("[data-entry-link]");
}

function getCatalogMenuToggle(target: Element) {
  return target.closest<HTMLButtonElement>("[data-menu-toggle]");
}

function shouldIgnoreCatalogEntryTarget(target: Element, entry: HTMLElement) {
  const interactive = target.closest<HTMLElement>(
    "a, button, input, select, textarea, [data-menu-toggle], .row-menu, .row-menu-shell",
  );
  return Boolean(interactive && entry.contains(interactive));
}

function openCatalogEntry(href: string, event: MouseEvent | KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || ("button" in event && event.button === 1)) {
    window.open(href, "_blank", "noopener");
    return;
  }

  window.location.assign(href);
}

function toggleCatalogRowMenu(button: HTMLElement) {
  const menuId = button.dataset.menuId;
  if (!menuId) {
    return;
  }

  const menu = document.getElementById(menuId);
  if (!menu) {
    return;
  }

  const willOpen = menu.hidden;
  closeCatalogRowMenus();
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
}

function closeCatalogMenusOnOutsideClick(event: MouseEvent) {
  const target = getCatalogEventTarget(event);
  if (target?.closest(".row-menu-shell")) {
    return;
  }

  closeCatalogRowMenus();
}

function closeCatalogRowMenus() {
  document.querySelectorAll<HTMLElement>(".row-menu").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll<HTMLElement>("[data-menu-toggle]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function readCatalogStateFromUrl(): CatalogState {
  const params = new URLSearchParams(window.location.search);
  const limit = clampLimit(params.get("limit"));
  const page = clampPage(params.get("page"));

  return {
    search: params.get("q")?.trim() ?? "",
    format: params.get("format")?.trim().toUpperCase() ?? "",
    season: params.get("season")?.trim().toUpperCase() ?? "",
    year: params.get("year")?.trim() ?? "",
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
  if (state.year) {
    params.set("year", state.year);
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

function readSheetWorkbookStateFromUrl(
  workbook: SheetWorkbookPayload,
  resolveSheet: (workbook: SheetWorkbookPayload, slug: string | null | undefined) => SheetWorkbookSheet,
): SheetWorkbookState {
  const params = new URLSearchParams(window.location.search);
  const activeSheet = resolveSheet(workbook, params.get("tab"));
  return {
    tab: activeSheet.slug,
    query: params.get("find")?.trim() ?? "",
  };
}

function syncSheetWorkbookStateToUrl(state: SheetWorkbookState) {
  const params = new URLSearchParams();
  if (state.tab) {
    params.set("tab", state.tab);
  }
  if (state.query) {
    params.set("find", state.query);
  }

  const query = params.toString();
  const nextUrl = query ? `/sheet?${query}` : "/sheet";
  window.history.replaceState(null, "", nextUrl);
}

function filterSeasonAndYear(items: CatalogIndexItem[], seasonFilter: string, yearFilter: string) {
  let result = items;
  if (seasonFilter) {
    result = result.filter((item) => (item.season ?? "").toUpperCase() === seasonFilter.toUpperCase());
  }
  if (yearFilter) {
    result = result.filter((item) => {
      const year = item.seasonYear ?? item.startYear;
      return year !== null && year !== undefined && String(year) === yearFilter;
    });
  }
  return result;
}

function buildSeasonOptions(items: CatalogIndexItem[]) {
  const unique = new Set<string>();
  for (const item of items) {
    if (item.season) {
      unique.add(item.season.toUpperCase());
    }
  }

  const order = ["WINTER", "SPRING", "SUMMER", "FALL"];
  return [...unique]
    .sort((left, right) => order.indexOf(left) - order.indexOf(right))
    .map((season) => ({
      value: season,
      label: capitalize(season.toLowerCase()),
    }));
}

function buildYearOptions(items: CatalogIndexItem[]) {
  const unique = new Set<number>();
  for (const item of items) {
    const year = item.seasonYear ?? item.startYear;
    if (year) {
      unique.add(year);
    }
  }

  return [...unique]
    .sort((left, right) => right - left)
    .map((year) => ({
      value: String(year),
      label: String(year),
    }));
}

function readGroupSummary(item: CatalogItem) {
  const bestGroups = item.bestGroups ?? [];
  const altGroups = item.altGroups ?? [];

  return {
    bestLabel: bestGroups.length
      ? (bestGroups[0] ?? "")
      : item.bestTorrentCount
        ? `${item.bestTorrentCount} release${item.bestTorrentCount === 1 ? "" : "s"}`
        : "",
    altLabel: altGroups.length
      ? (altGroups[0] ?? "")
      : item.torrentCount - item.bestTorrentCount > 0
        ? `${item.torrentCount - item.bestTorrentCount} release${item.torrentCount - item.bestTorrentCount === 1 ? "" : "s"}`
        : "",
  };
}

async function getCatalog() {
  if (!cachedCatalogPromise) {
    cachedCatalogPromise = fetchJson<CatalogIndexPayload>(`${DATA_ROOT}/catalog.json`);
  }
  return cachedCatalogPromise;
}

async function loadSheetWorkbookPayload(): Promise<SheetWorkbookPayload> {
  if (!cachedSheetWorkbookPromise) {
    cachedSheetWorkbookPromise = fetchJson<SheetWorkbookPayload>(`${DATA_ROOT}/sheet-workbook.json`);
  }
  return cachedSheetWorkbookPromise;
}

function loadSheetRenderer() {
  cachedSheetRendererPromise ??= import("./sheet-workbook");
  return cachedSheetRendererPromise;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new HttpStatusError(url, response.status, message);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (url.startsWith(DATA_ROOT) && contentType.includes("text/html")) {
    throw new MirrorDataMissingError(url);
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    if (url.startsWith(DATA_ROOT) && /^\s*<!doctype html/i.test(body)) {
      throw new MirrorDataMissingError(url);
    }

    throw new Error(
      error instanceof Error ? `Invalid JSON returned from ${url}: ${error.message}` : `Invalid JSON returned from ${url}.`,
    );
  }
}

function isMirrorDataMissingError(error: unknown) {
  return (
    error instanceof MirrorDataMissingError ||
    (error instanceof HttpStatusError && error.status === 404 && error.url.startsWith(DATA_ROOT))
  );
}

function isNotFoundForUrl(error: unknown, expectedUrl: string) {
  return error instanceof HttpStatusError && error.status === 404 && error.url === expectedUrl;
}

function applySavedTheme() {
  const saved = readSavedTheme();
  applyTheme(saved === "light" ? "light" : "dark");
}

function readSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function saveTheme(theme: "dark" | "light") {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Theme persistence is optional; keep runtime theme applied.
  }
}

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function createRenderScheduler(callback: () => void | Promise<void>) {
  let frameId: number | null = null;

  return () => {
    if (frameId !== null) {
      return;
    }

    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      void callback();
    });
  };
}

function bindMediaQueryChange(mediaQuery: MediaQueryList, callback: () => void) {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", callback);
    return;
  }

  mediaQuery.addListener(callback);
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

function setDocumentMeta(title: string) {
  document.title = title;
}

function normalizeExternalUrl(value: string) {
  if (!value) {
    return UPSTREAM_SITE_URL;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://${value.replace(/^\/+/, "")}`;
}

function initializeCustomDropdowns() {
  const selects = document.querySelectorAll<HTMLSelectElement>(
    ".catalog-toolbar select:not(.custom-select-initialized)",
  );

  selects.forEach((select) => {
    select.classList.add("custom-select-initialized");

    const parent = select.parentElement;
    if (!parent) return;

    const isDashed = parent.classList.contains("control-select--dashed") || parent.classList.contains("sheet-pill-select--dashed");
    const labelSpan = parent.querySelector("span");
    const labelText = labelSpan ? labelSpan.textContent || "" : "";

    const iconSvg = parent.querySelector("svg");
    const iconHtml = iconSvg ? iconSvg.outerHTML : "";

    const wrapper = document.createElement("div");
    wrapper.className = parent.className;
    wrapper.classList.add("custom-select");
    if (isDashed) {
      wrapper.classList.add("custom-select--dashed");
    }
    wrapper.setAttribute("data-for", select.id);

    parent.parentNode?.insertBefore(wrapper, parent);
    wrapper.appendChild(select);
    select.style.display = "none";

    if (labelText) {
      const label = document.createElement("span");
      label.className = "custom-select__label";
      label.textContent = labelText;
      wrapper.appendChild(label);
    }

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    let triggerContentHtml = "";
    if (iconHtml) {
      triggerContentHtml += iconHtml;
      wrapper.classList.add("custom-select--has-icon");
    }

    triggerContentHtml += `<span class="custom-select__trigger-text"></span>`;
    triggerContentHtml += `<span class="custom-select__arrow"></span>`;
    trigger.innerHTML = triggerContentHtml;
    wrapper.appendChild(trigger);

    const dropdown = document.createElement("div");
    dropdown.className = "custom-select__dropdown";
    dropdown.setAttribute("role", "listbox");
    dropdown.setAttribute("hidden", "");
    wrapper.appendChild(dropdown);

    const syncOptions = () => {
      dropdown.innerHTML = "";

      const scrollWrapper = document.createElement("div");
      scrollWrapper.className = "custom-select__dropdown-scroll";
      dropdown.appendChild(scrollWrapper);

      const options = select.options;
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const optionEl = document.createElement("div");
        optionEl.className = "custom-select__option";
        optionEl.setAttribute("data-value", opt.value);
        optionEl.setAttribute("role", "option");

        const isSelected = opt.selected;
        if (isSelected) {
          optionEl.classList.add("is-selected");
          optionEl.setAttribute("aria-selected", "true");
        }

        optionEl.innerHTML = `
          <span>${escapeHtml(opt.text)}</span>
          <svg class="custom-select__check" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="10 3 4.5 8.5 2 6"></polyline>
          </svg>
        `;

        optionEl.addEventListener("click", (e) => {
          e.stopPropagation();
          select.value = opt.value;
          select.dispatchEvent(new Event("change"));
          closeDropdown();
          trigger.focus();
        });

        scrollWrapper.appendChild(optionEl);
      }

      const selectedOpt = select.options[select.selectedIndex] || select.options[0];
      const triggerTextEl = trigger.querySelector(".custom-select__trigger-text");
      if (triggerTextEl) {
        triggerTextEl.textContent = selectedOpt ? selectedOpt.text : "";
      }
    };

    syncOptions();

    const toggleDropdown = (e: Event) => {
      e.stopPropagation();
      const isOpen = wrapper.hasAttribute("data-open");
      if (isOpen) {
        closeDropdown();
      } else {
        openDropdown();
      }
    };

    const openDropdown = () => {
      closeAllCustomDropdowns(wrapper);

      wrapper.setAttribute("data-open", "");
      dropdown.removeAttribute("hidden");
      trigger.setAttribute("aria-expanded", "true");

      const selectedEl = dropdown.querySelector(".custom-select__option.is-selected");
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }

      dropdown.querySelectorAll(".custom-select__option").forEach(o => o.classList.remove("is-focused"));
      selectedEl?.classList.add("is-focused");
    };

    const closeDropdown = () => {
      wrapper.removeAttribute("data-open");
      dropdown.setAttribute("hidden", "");
      trigger.setAttribute("aria-expanded", "false");
    };

    trigger.addEventListener("click", toggleDropdown);

    select.addEventListener("change", () => {
      syncOptions();
    });

    trigger.addEventListener("keydown", (e: KeyboardEvent) => {
      const isOpen = wrapper.hasAttribute("data-open");
      const optionsArray = Array.from(dropdown.querySelectorAll<HTMLDivElement>(".custom-select__option"));
      let focusedIndex = optionsArray.findIndex(o => o.classList.contains("is-focused"));
      const hasOptions = optionsArray.length > 0;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) {
          openDropdown();
          return;
        }
        if (!hasOptions) {
          return;
        }

        if (e.key === "ArrowDown") {
          focusedIndex = (focusedIndex + 1) % optionsArray.length;
        } else {
          focusedIndex = (focusedIndex - 1 + optionsArray.length) % optionsArray.length;
        }

        optionsArray.forEach(o => o.classList.remove("is-focused"));
        const newFocused = optionsArray[focusedIndex];
        newFocused?.classList.add("is-focused");
        newFocused?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Home" || e.key === "End") {
        if (isOpen && hasOptions) {
          e.preventDefault();
          focusedIndex = e.key === "Home" ? 0 : optionsArray.length - 1;
          optionsArray.forEach(o => o.classList.remove("is-focused"));
          const newFocused = optionsArray[focusedIndex];
          newFocused?.classList.add("is-focused");
          newFocused?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        if (isOpen && hasOptions) {
          e.preventDefault();
          const step = 10;
          if (e.key === "PageDown") {
            focusedIndex = Math.min(optionsArray.length - 1, focusedIndex + step);
          } else {
            focusedIndex = Math.max(0, focusedIndex - step);
          }
          optionsArray.forEach(o => o.classList.remove("is-focused"));
          const newFocused = optionsArray[focusedIndex];
          newFocused?.classList.add("is-focused");
          newFocused?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isOpen) {
          openDropdown();
        } else {
          if (!hasOptions) {
            return;
          }
          const newFocused = optionsArray[focusedIndex];
          if (newFocused) {
            const val = newFocused.getAttribute("data-value") || "";
            select.value = val;
            select.dispatchEvent(new Event("change"));
            closeDropdown();
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeDropdown();
      } else if (e.key === "Tab") {
        closeDropdown();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Simple typeahead: search for options starting with the typed letter
        const char = e.key.toLowerCase();
        if (!isOpen) {
          openDropdown();
        }
        if (!hasOptions) {
          return;
        }

        const startIndex = (focusedIndex + 1) % optionsArray.length;
        let matchIndex = -1;
        for (let i = 0; i < optionsArray.length; i++) {
          const checkIndex = (startIndex + i) % optionsArray.length;
          const optEl = optionsArray[checkIndex];
          const text = optEl.querySelector("span")?.textContent?.trim().toLowerCase() || "";
          if (text.startsWith(char)) {
            matchIndex = checkIndex;
            break;
          }
        }

        if (matchIndex !== -1) {
          e.preventDefault();
          focusedIndex = matchIndex;
          optionsArray.forEach(o => o.classList.remove("is-focused"));
          const newFocused = optionsArray[focusedIndex];
          newFocused?.classList.add("is-focused");
          newFocused?.scrollIntoView({ block: "nearest" });
        }
      }
    });

    parent.remove();
  });
}

function closeAllCustomDropdowns(exceptEl?: HTMLElement) {
  document.querySelectorAll(".custom-select[data-open]").forEach((el) => {
    if (el !== exceptEl) {
      el.removeAttribute("data-open");
      const drp = el.querySelector(".custom-select__dropdown");
      drp?.setAttribute("hidden", "");
      const trg = el.querySelector(".custom-select__trigger");
      trg?.setAttribute("aria-expanded", "false");
    }
  });
}

// Global click event to close dropdowns when clicking outside
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".custom-select")) {
    closeAllCustomDropdowns();
  }
});
 
function wireFilterDrawer() {
  const trigger = document.querySelector<HTMLButtonElement>("#mobile-filter-trigger");
  const filtersContainer = document.querySelector<HTMLDivElement>("#catalog-toolbar-filters");
 
  if (!trigger || !filtersContainer) return;
 
  let isOpen = false;
 
  trigger.addEventListener("click", () => {
    isOpen = !isOpen;
    trigger.setAttribute("aria-expanded", String(isOpen));
    filtersContainer.classList.toggle("is-expanded", isOpen);
  });
}
