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
  const tabs = [
    `<div class="skeleton-block sheet-skeleton__tab" style="width: 4rem;"></div>`,
    `<div class="skeleton-block sheet-skeleton__tab" style="width: 5rem;"></div>`,
    `<div class="skeleton-block sheet-skeleton__tab" style="width: 4.5rem;"></div>`,
  ].join("");

  const rowSpecs = [
    { title: "65%", altTitle: "45%", best: "35%", altRel: "30%", dual: "25%", notes: "70%" },
    { title: "85%", altTitle: "60%", best: "45%", altRel: "35%", dual: "25%", notes: "85%" },
    { title: "50%", altTitle: "40%", best: "30%", altRel: "20%", dual: "25%", notes: "40%" },
    { title: "75%", altTitle: "55%", best: "40%", altRel: "45%", dual: "25%", notes: "90%" },
    { title: "40%", altTitle: "30%", best: "25%", altRel: "25%", dual: "25%", notes: "50%" },
    { title: "70%", altTitle: "50%", best: "35%", altRel: "40%", dual: "25%", notes: "75%" },
    { title: "55%", altTitle: "35%", best: "30%", altRel: "20%", dual: "25%", notes: "60%" },
    { title: "80%", altTitle: "65%", best: "45%", altRel: "30%", dual: "25%", notes: "80%" },
    { title: "60%", altTitle: "40%", best: "30%", altRel: "25%", dual: "25%", notes: "65%" },
    { title: "90%", altTitle: "70%", best: "50%", altRel: "40%", dual: "25%", notes: "85%" },
    { title: "45%", altTitle: "35%", best: "25%", altRel: "20%", dual: "25%", notes: "45%" },
    { title: "70%", altTitle: "50%", best: "35%", altRel: "30%", dual: "25%", notes: "70%" },
    { title: "60%", altTitle: "45%", best: "30%", altRel: "25%", dual: "25%", notes: "55%" },
    { title: "75%", altTitle: "55%", best: "40%", altRel: "35%", dual: "25%", notes: "80%" },
  ];

  const rows = rowSpecs
    .map(
      (spec) => `
        <tr class="sheet-table__row sheet-skeleton__row">
          <td class="sheet-table__cell sheet-table__cell--number"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line sheet-skeleton__cell-line--num"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.title};"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.altTitle};"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.best};"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.altRel};"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.dual};"></div></div></td>
          <td class="sheet-table__cell"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__cell-line" style="width: ${spec.notes};"></div></div></td>
        </tr>
      `,
    )
    .join("");

  return `
    <main class="page page--sheet">
      <section class="sheet-workbook sheet-skeleton" aria-busy="true">
        <span class="skeleton-sr">Loading sheet workbook...</span>
        <div class="sheet-workbook__panel sheet-workbook__masthead sheet-skeleton__masthead" aria-hidden="true">
          <div class="sheet-workbook__title-row">
            <div class="skeleton-block sheet-skeleton__title"></div>
            <div class="skeleton-block sheet-skeleton__badge"></div>
          </div>
          <div class="sheet-workbook__masthead-actions sheet-skeleton__masthead-actions">
            <div class="skeleton-block sheet-skeleton__upstream"></div>
            <div class="skeleton-block sheet-skeleton__credit"></div>
          </div>
        </div>
        <div class="sheet-workbook__panel sheet-workbook__toolbar sheet-skeleton__toolbar" aria-hidden="true">
          <div class="sheet-workbook__tabs sheet-skeleton__tabs">${tabs}</div>
          <div class="sheet-workbook__toolbar-side">
            <div class="skeleton-block sheet-workbook__search sheet-skeleton__search"></div>
          </div>
        </div>
        <section class="sheet-workbook__grid sheet-skeleton__grid" aria-hidden="true">
          <div class="sheet-table-shell">
            <div class="sheet-table-scroll">
              <table class="sheet-table sheet-skeleton__table">
                <colgroup>
                  <col style="width:56px" />
                  <col style="width:314px" />
                  <col style="width:318px" />
                  <col style="width:252px" />
                  <col style="width:252px" />
                  <col style="width:108px" />
                  <col style="width:560px" />
                </colgroup>
                <thead>
                  <tr class="sheet-skeleton__head-row">
                    <th class="sheet-table__head sheet-table__head--number"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line sheet-skeleton__head-line--num"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 45px;"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 95px;"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 80px;"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 100px;"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 65px;"></div></div></th>
                    <th class="sheet-table__head"><div class="sheet-cell-body"><div class="skeleton-block sheet-skeleton__head-line" style="width: 45px;"></div></div></th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </section>
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
