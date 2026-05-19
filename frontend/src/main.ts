import "./styles.css";
import {
  filterCatalogItems,
  type CatalogIndexItem,
  type CatalogIndexPayload,
  type CatalogItem,
  type CatalogPayload,
  type EntryPayload,
  type MirrorStatus,
  type SheetPayload,
} from "../../shared/mirror";

const DATA_ROOT = "/mirror-data";
const DEFAULT_PAGE_SIZE = 30;
const SEARCH_RESULTS_LIMIT = 10;
const THEME_KEY = "seadex-mirror-theme";
const UPSTREAM_SITE_URL = "https://releases.moe/";
const UPSTREAM_ABOUT_URL = "https://releases.moe/about/";
const UPSTREAM_SHEET_URL = "https://sheet.releases.moe/";
const UPSTREAM_SHEET_EMBED_URL =
  "https://docs.google.com/spreadsheets/d/1emW2Zsb0gEtEHiub_YHpazvBd4lL4saxCwyPhbtxXYM/htmlview";
const DEVELOPER_GITHUB_URL = "https://github.com/EithonX";

type RouteContext =
  | { kind: "index" }
  | { kind: "about" }
  | { kind: "sheet" }
  | { kind: "entry"; alId: number };

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
    case "entry":
      await renderEntry(status, route.alId);
      return;
  }
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
                <input id="catalog-search" class="control-input" type="search" placeholder="Filter anime..." value="${escapeHtml(state.search)}" autocomplete="off" />
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

async function renderSheet(status: MirrorStatus) {
  const sheet = await loadSheetPayload();
  const state = readCatalogStateFromUrl();
  let sheetView: "live" | "backup" = readSheetViewFromUrl();

  appRoot.innerHTML = renderPageFrame(
    status,
    "sheet",
    `
      <main class="page page--sheet">
        <section class="sheet-page">
          <div class="sheet-modebar">
            <div class="sheet-modebar__copy">
              <p class="sheet-kicker">Sheet</p>
              <h1>SeaDex sheet mirror</h1>
              <p>Live embedded sheet by default, with a local backup table when the upstream embed is unavailable.</p>
            </div>
            <div class="sheet-modebar__actions">
              <button id="sheet-live-tab" class="sheet-mode-button${sheetView === "live" ? " is-active" : ""}" type="button">Live sheet</button>
              <button id="sheet-backup-tab" class="sheet-mode-button${sheetView === "backup" ? " is-active" : ""}" type="button">Mirror backup</button>
              <a class="comparison-link comparison-link--secondary" href="${escapeHtml(UPSTREAM_SHEET_URL)}" target="_blank" rel="noreferrer">
                <span>${renderExternalIcon()}</span>
                <span>Open upstream</span>
              </a>
            </div>
          </div>

          <section id="sheet-live-panel" class="sheet-frame-shell"${sheetView === "backup" ? " hidden" : ""}>
            <iframe
              class="sheet-frame"
              src="${escapeHtml(UPSTREAM_SHEET_EMBED_URL)}"
              loading="lazy"
              referrerpolicy="no-referrer"
              title="SeaDex sheet embed"
            ></iframe>
          </section>

          <section id="sheet-backup-panel"${sheetView === "live" ? " hidden" : ""}>
            <div class="catalog-toolbar catalog-toolbar--sheet">
              <div class="catalog-toolbar__group catalog-toolbar__group--grow">
              <label class="control-shell control-shell--search" for="sheet-search">
                ${renderSearchIcon()}
                <input id="sheet-search" class="control-input" type="search" placeholder="Filter titles..." value="${escapeHtml(state.search)}" autocomplete="off" />
              </label>
              <label class="sheet-pill-select sheet-pill-select--dashed">
                ${renderPlusCircledIcon()}
                <span>Format</span>
                <select id="sheet-format">
                  <option value="">All formats</option>
                  ${renderFormatOptions(state.format)}
                </select>
              </label>
            </div>
              <div class="catalog-toolbar__group">
              <label class="sheet-pill-select">
                ${renderMixerIcon()}
                <span>View</span>
                <select id="sheet-sort">
                  <option value="updated"${state.sort === "updated" ? " selected" : ""}>Latest updates</option>
                  <option value="title"${state.sort === "title" ? " selected" : ""}>Alphabetical</option>
                  <option value="year"${state.sort === "year" ? " selected" : ""}>Newest year</option>
                  <option value="score"${state.sort === "score" ? " selected" : ""}>Highest score</option>
                </select>
              </label>
            </div>
            </div>

            <section class="catalog-table-shell catalog-table-shell--sheet">
              <div class="catalog-table-shell__scroll">
                <table class="catalog-table catalog-table--sheet" aria-label="SeaDex mirror sheet backup">
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
                  <tbody id="sheet-body"></tbody>
                </table>
              </div>
              <div id="sheet-mobile" class="catalog-mobile"></div>
            </section>

            <div class="catalog-footer">
              <div class="catalog-footer__summary" id="sheet-summary">Loading rows...</div>
              <div class="catalog-footer__controls">
                <label class="rows-control">
                  <span>Rows per page</span>
                  <select id="sheet-limit">
                    <option value="15"${state.limit === 15 ? " selected" : ""}>15</option>
                    <option value="30"${state.limit === 30 ? " selected" : ""}>30</option>
                    <option value="60"${state.limit === 60 ? " selected" : ""}>60</option>
                    <option value="90"${state.limit === 90 ? " selected" : ""}>90</option>
                  </select>
                </label>
                <div class="page-indicator" id="sheet-indicator">Page 1 of 1</div>
                <div class="pager">
                  <button id="sheet-first" class="ghost-icon-button ghost-icon-button--desktop" type="button" aria-label="Go to first page">${renderDoubleChevronLeftIcon()}</button>
                  <button id="sheet-prev" class="ghost-icon-button" type="button" aria-label="Go to previous page">${renderChevronLeftIcon()}</button>
                  <button id="sheet-next" class="ghost-icon-button" type="button" aria-label="Go to next page">${renderChevronRightIcon()}</button>
                  <button id="sheet-last" class="ghost-icon-button ghost-icon-button--desktop" type="button" aria-label="Go to last page">${renderDoubleChevronRightIcon()}</button>
                </div>
              </div>
            </div>
          </section>
        </section>
      </main>
      ${renderSearchDialog()}
    `,
  );

  wireCommonUi(status, "sheet");

  const liveTab = query<HTMLButtonElement>("#sheet-live-tab");
  const backupTab = query<HTMLButtonElement>("#sheet-backup-tab");
  const livePanel = query<HTMLElement>("#sheet-live-panel");
  const backupPanel = query<HTMLElement>("#sheet-backup-panel");
  const searchInput = query<HTMLInputElement>("#sheet-search");
  const formatSelect = query<HTMLSelectElement>("#sheet-format");
  const sortSelect = query<HTMLSelectElement>("#sheet-sort");
  const limitSelect = query<HTMLSelectElement>("#sheet-limit");
  const body = query<HTMLTableSectionElement>("#sheet-body");
  const mobile = query<HTMLDivElement>("#sheet-mobile");
  const summary = query<HTMLDivElement>("#sheet-summary");
  const indicator = query<HTMLDivElement>("#sheet-indicator");
  const firstButton = query<HTMLButtonElement>("#sheet-first");
  const previousButton = query<HTMLButtonElement>("#sheet-prev");
  const nextButton = query<HTMLButtonElement>("#sheet-next");
  const lastButton = query<HTMLButtonElement>("#sheet-last");

  let currentPayload: ReturnType<typeof filterSheetItems> | null = null;

  const applySheetView = (nextView: "live" | "backup") => {
    sheetView = nextView;
    livePanel.hidden = nextView !== "live";
    backupPanel.hidden = nextView !== "backup";
    liveTab.classList.toggle("is-active", nextView === "live");
    backupTab.classList.toggle("is-active", nextView === "backup");
    syncSheetStateToUrl(state, nextView);
  };

  const renderPage = () => {
    state.search = searchInput.value.trim();
    state.format = formatSelect.value;
    state.sort = sortSelect.value;
    state.limit = clampLimit(limitSelect.value);

    const payload = filterSheetItems(sheet.items, state);
    currentPayload = payload;
    state.offset = payload.filters.offset;
    const totalPages = Math.max(1, Math.ceil(payload.pagination.total / state.limit));
    const currentPage = Math.floor(payload.filters.offset / state.limit) + 1;

    body.innerHTML = payload.items.length
      ? payload.items
          .map(
            (item) => `
          <tr class="catalog-row" data-entry-link="/${item.alId}" tabindex="0">
            <td>
              <div class="catalog-title">
                <span class="catalog-title__text">${escapeHtml(item.title)}</span>
                ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
              </div>
            </td>
            <td>${escapeHtml(formatCatalogFormat(item.format))}</td>
            <td>${item.year ?? "-"}</td>
            <td>${item.episodes ?? "-"}</td>
            <td class="sheet-groups">${escapeHtml(formatSheetGroupLabel(item.bestGroups, item.bestCount))}</td>
            <td class="sheet-groups">${escapeHtml(formatSheetGroupLabel(item.altGroups, item.altCount))}</td>
            <td>${formatDate(item.updatedAt)}</td>
            <td class="catalog-row__actions">
              <div class="row-menu-shell">
                <button class="row-menu-toggle" type="button" aria-label="Open row menu" data-menu-toggle data-menu-id="sheet-row-menu-${item.alId}">
                  ${renderDotsIcon()}
                </button>
                <div id="sheet-row-menu-${item.alId}" class="row-menu" hidden>
                  <a href="/${item.alId}">Open entry</a>
                  <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer">AniList</a>
                  <a href="${escapeHtml(UPSTREAM_SITE_URL)}${item.alId}/" target="_blank" rel="noreferrer">Upstream entry</a>
                </div>
              </div>
            </td>
          </tr>
        `,
          )
          .join("")
      : `<tr><td class="catalog-empty" colspan="8">No entries matched that sheet filter.</td></tr>`;

    mobile.innerHTML = payload.items.length
      ? payload.items
          .map(
            (item) => `
          <article class="catalog-card" data-entry-link="/${item.alId}" tabindex="0">
            <div class="catalog-card__top">
              <div class="catalog-card__title">
                <strong>${escapeHtml(item.title)}</strong>
                ${item.incomplete ? `<span class="pill pill--warn">Incomplete</span>` : ""}
              </div>
              <button class="row-menu-toggle" type="button" aria-label="Open row menu" data-menu-toggle data-menu-id="sheet-mobile-row-menu-${item.alId}">
                ${renderDotsIcon()}
              </button>
              <div id="sheet-mobile-row-menu-${item.alId}" class="row-menu row-menu--mobile" hidden>
                <a href="/${item.alId}">Open entry</a>
                <a href="https://anilist.co/anime/${item.alId}" target="_blank" rel="noreferrer">AniList</a>
                <a href="${escapeHtml(UPSTREAM_SITE_URL)}${item.alId}/" target="_blank" rel="noreferrer">Upstream entry</a>
              </div>
            </div>
            <div class="catalog-card__meta">
              <span>${escapeHtml(formatCatalogFormat(item.format))}</span>
              <span>${item.year ?? "Unknown"}</span>
              <span>${item.episodes ?? "?"} ep</span>
            </div>
            <dl class="catalog-card__groups">
              <div>
                <dt>Best</dt>
                <dd>${escapeHtml(formatSheetGroupLabel(item.bestGroups, item.bestCount))}</dd>
              </div>
              <div>
                <dt>Alt</dt>
                <dd>${escapeHtml(formatSheetGroupLabel(item.altGroups, item.altCount))}</dd>
              </div>
            </dl>
            ${item.excerpt ? `<p class="sheet-mobile-notes">${escapeHtml(item.excerpt)}</p>` : ""}
            <div class="catalog-card__footer">Updated ${formatDate(item.updatedAt)}</div>
          </article>
        `,
          )
          .join("")
      : `<div class="catalog-empty catalog-empty--mobile">No entries matched that sheet filter.</div>`;

    summary.textContent = `${payload.pagination.count} row(s) loaded.`;
    indicator.textContent = `Page ${currentPage} of ${totalPages}`;
    firstButton.disabled = state.offset === 0;
    previousButton.disabled = state.offset === 0;
    nextButton.disabled = payload.pagination.nextOffset === null;
    lastButton.disabled = currentPage >= totalPages;

    syncSheetStateToUrl(state, sheetView);
    wireCatalogActions(body, mobile);
  };

  const rerenderFromTop = () => {
    state.offset = 0;
    renderPage();
  };

  searchInput.addEventListener("input", debounce(rerenderFromTop, 100));
  formatSelect.addEventListener("change", rerenderFromTop);
  sortSelect.addEventListener("change", rerenderFromTop);
  limitSelect.addEventListener("change", rerenderFromTop);

  firstButton.addEventListener("click", () => {
    state.offset = 0;
    renderPage();
  });

  previousButton.addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    renderPage();
  });

  nextButton.addEventListener("click", () => {
    if (currentPayload?.pagination.nextOffset === null || currentPayload?.pagination.nextOffset === undefined) {
      return;
    }
    state.offset = currentPayload.pagination.nextOffset;
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

  liveTab.addEventListener("click", () => {
    applySheetView("live");
  });

  backupTab.addEventListener("click", () => {
    applySheetView("backup");
  });

  applySheetView(sheetView);
  renderPage();
}

function renderAbout(status: MirrorStatus) {
  appRoot.innerHTML = renderPageFrame(
    status,
    "about",
    `
      <main class="page page--about">
        <section class="about-page">
          <article class="about-essay">
            <p class="sheet-kicker">About</p>
            <h1>Why this mirror exists</h1>
            <p>
              SeaDex is too useful to be fragile. This mirror exists to keep the browsing experience fast, cheap to host, and readable on both desktop and mobile without wasting quota on a live database for every page view.
            </p>
            <p>
              The project is maintained by <strong>EithonX</strong>. The idea is not to replace SeaDex or erase the original work. The idea is to preserve the experience, mirror the public data responsibly, and improve the parts that matter for day to day use.
            </p>

            <hr class="section-divider" />

            <div class="about-list">
              <div>
                <h2>What is different here</h2>
                <p>Static snapshots instead of constant live reads, safer rebuild logic, cleaner mobile behavior, and room for mirror-specific UX improvements once parity is stable.</p>
              </div>
              <div>
                <h2>Who to credit</h2>
                <p>SeaDex and releases.moe remain the source project. This mirror only republishes public-facing information with attribution.</p>
              </div>
              <div>
                <h2>Where to find me</h2>
                <div class="about-card__actions">
                  <a class="comparison-link comparison-link--secondary" href="${escapeHtml(DEVELOPER_GITHUB_URL)}" target="_blank" rel="noreferrer">
                    <span>${renderGithubIcon()}</span>
                    <span>github.com/EithonX</span>
                  </a>
                </div>
              </div>
              <div>
                <h2>Upstream pages</h2>
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
  const catalog = await getCatalog();
  const availableIds = new Set(catalog.items.map((item) => item.alId));
  const filteredRelations = entry.relations.filter((relation) => {
    const relationType = relation.relationType?.toUpperCase();
    const node = relation.node as (EntryPayload["entry"]["relations"][number]["node"] & { type?: string | null }) | undefined;
    return (
      (relationType === "PREQUEL" || relationType === "SEQUEL") &&
      node?.id !== undefined &&
      availableIds.has(node.id) &&
      (node.type === undefined || node.type === null || node.type === "ANIME")
    );
  });
  setDocumentMeta(`${entry.titles.display} | SeaDex Mirror`);

  appRoot.innerHTML = renderPageFrame(
    status,
    "entry",
    `
      <main class="page page--entry">
        <div class="entry-layout">
          <aside class="entry-sidebar">
            <section class="entry-hero">
              <div class="entry-hero__poster">
                ${
                  entry.coverImage.extraLarge
                    ? `<img src="${escapeHtml(entry.coverImage.extraLarge)}" alt="${escapeHtml(entry.titles.display)} cover" />`
                    : `<div class="poster-fallback">No poster art was included in the snapshot.</div>`
                }
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
              <div class="sidebar-stack sidebar-stack--links">
                <a class="comparison-link comparison-link--secondary" href="${escapeHtml(payload.source.originalEntryUrl)}" target="_blank" rel="noreferrer">
                  <img src="/favicon.png" alt="SeaDex" />
                  <span>SeaDex</span>
                </a>
                <a class="comparison-link comparison-link--secondary" href="https://anilist.co/anime/${entry.alId}" target="_blank" rel="noreferrer">
                  <img src="/anilist.svg" alt="AniList" />
                  <span>AniList</span>
                </a>
              </div>
            </section>
          </aside>

          <section class="entry-main">
            <section class="content-section">
              <h2>Torrents</h2>
              <div class="torrent-grid">
                ${
                  entry.theoreticalBest
                    ? `
                      <article class="torrent-card torrent-card--theoretical">
                        <div class="torrent-card__header">
                          <h3>${escapeHtml(entry.theoreticalBest)}</h3>
                        </div>
                        <div class="torrent-card__badges">
                          <span class="pill pill--warn">Unmuxed</span>
                          <span class="pill pill--best">Best</span>
                        </div>
                      </article>
                    `
                    : ""
                }
                ${payload.torrents.map(renderTorrentCard).join("")}
              </div>
            </section>

            <hr class="section-divider" />

            <section class="content-section">
              <h2>Notes</h2>
              <div class="entry-notes">${escapeHtml(entry.notes || "No notes were included for this entry.")}</div>
            </section>

            ${renderRelationsSection(filteredRelations)}

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
          <a class="ghost-icon-button" href="${escapeHtml(originalSiteUrl)}" target="_blank" rel="noreferrer" aria-label="Open original SeaDex site">
            ${renderExternalIcon()}
          </a>
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
            ? `<a class="torrent-button" href="${escapeHtml(links.publicUrl)}" target="_blank" rel="noreferrer">${renderTrackerIcon(links.publicLabel)} ${escapeHtml(links.publicLabel)}</a>`
            : `<span class="torrent-button torrent-button--muted">No public link</span>`
        }
        ${
          links.hasPrivate
            ? `<span class="torrent-button torrent-button--private" aria-disabled="true">${renderPrivateTrackerIcon()} Private Tracker</span>`
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

function wireCommonUi(status: MirrorStatus, context: "index" | "entry" | "about" | "sheet") {
  wireThemeToggle();
  wireSearchDialog(status, context);
  if (context === "index" || context === "sheet") {
    initializeCustomDropdowns();
  }
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
    closeAllCustomDropdowns();
    dialog.hidden = false;
    dialog.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    document.body.classList.add("is-modal-open");
    isOpen = true;

    if (context === "index" || context === "sheet") {
      const sourceSearch =
        document.querySelector<HTMLInputElement>("#catalog-search") ??
        document.querySelector<HTMLInputElement>("#sheet-search");
      input.value = sourceSearch?.value ?? "";
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
  if (mobileList !== body) {
    attachRowHandlers(mobileList);
  }
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

function readSheetViewFromUrl(): "live" | "backup" {
  const params = new URLSearchParams(window.location.search);
  return params.get("sheetView") === "backup" ? "backup" : "live";
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

function syncSheetStateToUrl(state: CatalogState, sheetView: "live" | "backup") {
  const params = new URLSearchParams();
  if (sheetView === "backup") {
    params.set("sheetView", "backup");
  }
  if (state.search) {
    params.set("q", state.search);
  }
  if (state.format) {
    params.set("format", state.format);
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
  const nextUrl = query ? `/sheet?${query}` : "/sheet";
  window.history.replaceState(null, "", nextUrl);
}

function filterSeason(items: CatalogIndexItem[], seasonFilter: string) {
  if (!seasonFilter) {
    return items;
  }

  return items.filter((item) => toSeasonKey(item.season, item.seasonYear ?? item.startYear) === seasonFilter);
}

function filterSheetItems(
  items: SheetPayload["items"],
  state: Pick<CatalogState, "search" | "format" | "sort" | "limit" | "offset">,
) {
  const search = state.search.trim().toLowerCase();
  const format = state.format.trim().toUpperCase();

  let filtered = items;
  if (search) {
    filtered = filtered.filter((item) => item.searchText.includes(search));
  }

  if (format) {
    filtered = filtered.filter((item) => (item.format ?? "").toUpperCase() === format);
  }

  const sorted = [...filtered].sort((left, right) => {
    switch (state.sort) {
      case "title":
        return left.title.localeCompare(right.title) || left.alId - right.alId;
      case "year":
        return (right.year ?? 0) - (left.year ?? 0) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      case "score":
        return (right.averageScore ?? 0) - (left.averageScore ?? 0) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      default:
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.title.localeCompare(right.title);
    }
  });

  const limit = Math.max(1, state.limit);
  const offset = Math.max(0, Math.min(state.offset, Math.max(0, sorted.length - 1)));
  const pageItems = sorted.slice(offset, offset + limit);
  const nextOffset = offset + limit < sorted.length ? offset + limit : null;

  return {
    filters: {
      search: state.search,
      format: state.format,
      sort: state.sort,
      limit,
      offset,
    },
    pagination: {
      count: pageItems.length,
      total: sorted.length,
      nextOffset,
    },
    items: pageItems,
  };
}

function formatSheetGroupLabel(groups: string[], count: number) {
  if (groups.length > 0) {
    return groups.join(" / ");
  }
  if (count > 0) {
    return `${count} release${count === 1 ? "" : "s"}`;
  }
  return "None";
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

async function loadSheetPayload(): Promise<SheetPayload> {
  try {
    return await fetchJson<SheetPayload>(`${DATA_ROOT}/sheet.json`);
  } catch (error) {
    if (!isMirrorDataMissingError(error)) {
      throw error;
    }

    const catalog = await getCatalog();
    return {
      generatedAt: catalog.generatedAt,
      items: catalog.items.map((item) => ({
        alId: item.alId,
        recordId: item.recordId,
        title: item.titles.display,
        format: item.format,
        status: item.status,
        year: item.startYear ?? item.seasonYear,
        episodes: item.episodes,
        averageScore: item.averageScore,
        incomplete: item.incomplete,
        comparisonCount: item.comparisonLinks.length,
        torrentCount: item.torrentCount,
        bestCount: item.bestTorrentCount,
        altCount: Math.max(0, item.torrentCount - item.bestTorrentCount),
        bestGroups: [],
        altGroups: [],
        excerpt: item.excerpt,
        updatedAt: item.sourceUpdatedAt,
        searchText: item.searchText,
      })),
    };
  }
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

  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (url.startsWith(DATA_ROOT) && contentType.includes("text/html")) {
    throw new Error(`Mirror data is missing at ${url}. Run \`npm run data:build\` before previewing the site.`);
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    if (url.startsWith(DATA_ROOT) && /^\s*<!doctype html/i.test(body)) {
      throw new Error(`Mirror data is missing at ${url}. Run \`npm run data:build\` before previewing the site.`);
    }

    throw new Error(
      error instanceof Error ? `Invalid JSON returned from ${url}: ${error.message}` : `Invalid JSON returned from ${url}.`,
    );
  }
}

function isMirrorDataMissingError(error: unknown) {
  return error instanceof Error && error.message.includes("Mirror data is missing");
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

function escapeHtml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSearchIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 6.5C10 8.433 8.433 10 6.5 10C4.567 10 3 8.433 3 6.5C3 4.567 4.567 3 6.5 3C8.433 3 10 4.567 10 6.5ZM9.30884 10.0159C8.53901 10.6318 7.56251 11 6.5 11C4.01472 11 2 8.98528 2 6.5C2 4.01472 4.01472 2 6.5 2C8.98528 2 11 4.01472 11 6.5C11 7.56251 10.6318 8.53901 10.0159 9.30884L12.8536 12.1464C13.0488 12.3417 13.0488 12.6583 12.8536 12.8536C12.6583 13.0488 12.3417 13.0488 12.1464 12.8536L9.30884 10.0159Z"></path></svg>`;
}

function renderPlusCircledIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.49991 0.876892C3.84222 0.876892 0.877075 3.84204 0.877075 7.49972C0.877075 11.1574 3.84222 14.1226 7.49991 14.1226C11.1576 14.1226 14.1227 11.1574 14.1227 7.49972C14.1227 3.84204 11.1576 0.876892 7.49991 0.876892ZM1.82707 7.49972C1.82707 4.36671 4.36689 1.82689 7.49991 1.82689C10.6329 1.82689 13.1727 4.36671 13.1727 7.49972C13.1727 10.6327 10.6329 13.1726 7.49991 13.1726C4.36689 13.1726 1.82707 10.6327 1.82707 7.49972ZM7.50003 4C7.77617 4 8.00003 4.22386 8.00003 4.5V7H10.5C10.7762 7 11 7.22386 11 7.5C11 7.77614 10.7762 8 10.5 8H8.00003V10.5C8.00003 10.7761 7.77617 11 7.50003 11C7.22389 11 7.00003 10.7761 7.00003 10.5V8H4.50003C4.22389 8 4.00003 7.77614 4.00003 7.5C4.00003 7.22386 4.22389 7 4.50003 7H7.00003V4.5C7.00003 4.22386 7.22389 4 7.50003 4Z"></path></svg>`;
}

function renderMixerIcon() {
  return `<svg width="24" height="24" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.5 3C4.67157 3 4 3.67157 4 4.5C4 5.32843 4.67157 6 5.5 6C6.32843 6 7 5.32843 7 4.5C7 3.67157 6.32843 3 5.5 3ZM3 5C3.01671 5 3.03323 4.99918 3.04952 4.99758C3.28022 6.1399 4.28967 7 5.5 7C6.71033 7 7.71978 6.1399 7.95048 4.99758C7.96677 4.99918 7.98329 5 8 5H13.5C13.7761 5 14 4.77614 14 4.5C14 4.22386 13.7761 4 13.5 4H8C7.98329 4 7.96677 4.00082 7.95048 4.00242C7.71978 2.86009 6.71033 2 5.5 2C4.28967 2 3.28022 2.86009 3.04952 4.00242C3.03323 4.00082 3.01671 4 3 4H1.5C1.22386 4 1 4.22386 1 4.5C1 4.77614 1.22386 5 1.5 5H3ZM11.9505 10.9976C11.7198 12.1399 10.7103 13 9.5 13C8.28967 13 7.28022 12.1399 7.04952 10.9976C7.03323 10.9992 7.01671 11 7 11H1.5C1.22386 11 1 10.7761 1 10.5C1 10.2239 1.22386 10 1.5 10H7C7.01671 10 7.03323 10.0008 7.04952 10.0024C7.28022 8.8601 8.28967 8 9.5 8C10.7103 8 11.7198 8.8601 11.9505 10.0024C11.9668 10.0008 11.9833 10 12 10H13.5C13.7761 10 14 10.2239 14 10.5C14 10.7761 13.7761 11 13.5 11H12C11.9833 11 11.9668 10.9992 11.9505 10.9976ZM8 10.5C8 9.67157 8.67157 9 9.5 9C10.3284 9 11 9.67157 11 10.5C11 11.3284 10.3284 12 9.5 12C8.67157 12 8 11.3284 8 10.5Z"></path></svg>`;
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

function renderTrackerIcon(label: string) {
  if (label === "Nyaa") {
    return `<img src="/cat.png" alt="" class="tracker-icon" />`;
  }

  return renderExternalIcon();
}

function renderPrivateTrackerIcon() {
  return `<img src="/lock.ico" alt="" class="tracker-icon tracker-icon--lock" />`;
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

function renderGithubIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.66.5 12.03c0 5.1 3.29 9.43 7.86 10.96.57.11.78-.25.78-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.41-1.27.74-1.56-2.56-.29-5.25-1.29-5.25-5.73 0-1.27.45-2.31 1.19-3.12-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.19 1.19a10.9 10.9 0 0 1 5.81 0c2.22-1.5 3.19-1.19 3.19-1.19.63 1.59.23 2.77.11 3.06.74.81 1.19 1.85 1.19 3.12 0 4.45-2.7 5.43-5.27 5.72.42.36.79 1.05.79 2.12 0 1.54-.01 2.77-.01 3.15 0 .31.2.68.79.56A11.54 11.54 0 0 0 23.5 12.03C23.5 5.66 18.35.5 12 .5Z"/></svg>`;
}

function initializeCustomDropdowns() {
  const selects = document.querySelectorAll<HTMLSelectElement>(
    ".catalog-toolbar select:not(.custom-select-initialized)"
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

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) {
          openDropdown();
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
        if (isOpen) {
          e.preventDefault();
          focusedIndex = e.key === "Home" ? 0 : optionsArray.length - 1;
          optionsArray.forEach(o => o.classList.remove("is-focused"));
          const newFocused = optionsArray[focusedIndex];
          newFocused?.classList.add("is-focused");
          newFocused?.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        if (isOpen) {
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
