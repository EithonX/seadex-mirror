import type { MirrorStatus } from "../../shared/mirror";
import { DEVELOPER_GITHUB_URL, DEVELOPER_GITHUB_USERNAME } from "./constants";
import { formatDate } from "./format";
import { escapeHtml } from "./html";
import { renderCloseIcon, renderMoonIcon, renderSearchIcon, renderSunIcon } from "./icons";

export type PageContext = "index" | "entry" | "about" | "sheet";

export function renderPageFrame(context: PageContext, content: string, status?: MirrorStatus) {
  return `
    ${renderShell(context)}
    ${content}
    ${renderSiteFooter(status)}
  `;
}

function renderShell(context: PageContext) {
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

export function renderSiteFooter(status?: MirrorStatus) {
  const entriesCount = status ? status.counts.entries.toLocaleString() : "2,796";
  const torrentsCount = status ? status.counts.torrents.toLocaleString() : "9,169";
  const updatedDate = status && status.sync.lastRebuildFinishedAt ? formatDate(status.sync.lastRebuildFinishedAt) : null;

  return `
    <footer class="site-footer">
      <div class="site-footer__inner">
        <div class="site-footer__left">
          <span class="site-footer__brand">SeaDex Mirror</span>
          <span class="site-footer__by">by <a href="${escapeHtml(DEVELOPER_GITHUB_URL)}" target="_blank" rel="noreferrer">${escapeHtml(DEVELOPER_GITHUB_USERNAME)}</a></span>
        </div>
        <div class="site-footer__right">
          <span class="stat-group"><strong class="stat-num">${entriesCount}</strong> entries</span>
          <span class="stat-sep">&bull;</span>
          <span class="stat-group"><strong class="stat-num">${torrentsCount}</strong> torrents</span>
          ${
            updatedDate
              ? `
                <span class="stat-sep stat-sep--time">&bull;</span>
                <span class="stat-group stat-group--time">Updated ${escapeHtml(updatedDate)}</span>
              `
              : ""
          }
        </div>
      </div>
    </footer>
  `;
}

export function renderSheetSkeleton() {
  const tabs = Array.from({ length: 5 })
    .map(() => `<div class="skeleton-block sheet-skeleton__tab"></div>`)
    .join("");

  const rows = Array.from({ length: 10 })
    .map(
      () => `
        <div class="sheet-skeleton__row" aria-hidden="true">
          <div class="skeleton-block sheet-skeleton__cell sheet-skeleton__cell--wide"></div>
          <div class="skeleton-block sheet-skeleton__cell"></div>
          <div class="skeleton-block sheet-skeleton__cell"></div>
          <div class="skeleton-block sheet-skeleton__cell sheet-skeleton__cell--short"></div>
        </div>
      `,
    )
    .join("");

  return `
    <main class="page page--sheet">
      <section class="sheet-workbook sheet-skeleton" aria-busy="true">
        <span class="skeleton-sr">Loading sheet workbook...</span>
        <div class="sheet-workbook__panel sheet-workbook__masthead sheet-skeleton__masthead" aria-hidden="true">
          <div class="skeleton-block sheet-skeleton__title"></div>
          <div class="skeleton-block sheet-skeleton__masthead-action"></div>
        </div>
        <div class="sheet-workbook__panel sheet-workbook__toolbar sheet-skeleton__toolbar" aria-hidden="true">
          <div class="sheet-skeleton__tabs">${tabs}</div>
          <div class="skeleton-block sheet-skeleton__search"></div>
        </div>
        <section class="sheet-workbook__grid sheet-skeleton__grid" aria-hidden="true">${rows}</section>
      </section>
    </main>
  `;
}

export function renderSearchDialog() {
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
