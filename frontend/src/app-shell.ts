import { DEVELOPER_GITHUB_URL } from "./constants";
import { escapeHtml } from "./html";
import { renderCloseIcon, renderMoonIcon, renderSearchIcon, renderSunIcon } from "./icons";

export type PageContext = "index" | "entry" | "about" | "sheet";

export function renderPageFrame(context: PageContext, content: string) {
  return `
    ${renderShell(context)}
    ${content}
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
