import type { CatalogIndexItem, CatalogItem } from "../../shared/mirror";
import { capitalize, formatCatalogFormat, formatDate } from "./format";
import { escapeHtml } from "./html";
import { renderDotsIcon } from "./icons";

export function renderCatalogSkeleton(): string {
  const desktopRows = Array.from({ length: 8 })
    .map(
      () => `
        <div class="catalog-skeleton__row" aria-hidden="true">
          <div class="catalog-skeleton__cell catalog-skeleton__cell--title">
            <div class="skeleton-block catalog-skeleton__poster"></div>
            <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--title"></div>
          </div>
          <div class="skeleton-block catalog-skeleton__line"></div>
          <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--short"></div>
          <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--short"></div>
          <div class="skeleton-block catalog-skeleton__line"></div>
          <div class="skeleton-block catalog-skeleton__line"></div>
          <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--short"></div>
        </div>
      `,
    )
    .join("");

  const mobileCards = Array.from({ length: 6 })
    .map(
      () => `
        <div class="catalog-skeleton__card" aria-hidden="true">
          <div class="skeleton-block catalog-skeleton__card-poster"></div>
          <div class="catalog-skeleton__card-body">
            <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--title"></div>
            <div class="skeleton-block catalog-skeleton__line catalog-skeleton__line--short"></div>
            <div class="skeleton-block catalog-skeleton__line"></div>
          </div>
        </div>
      `,
    )
    .join("");

  return `
    <section class="catalog-page catalog-page--skeleton" aria-busy="true">
      <span class="skeleton-sr">Loading mirrored catalog...</span>
      <div class="catalog-toolbar catalog-skeleton__toolbar" aria-hidden="true">
        <div class="catalog-toolbar__group catalog-toolbar__group--search">
          <div class="skeleton-block catalog-skeleton__toolbar-search"></div>
          <div class="skeleton-block catalog-skeleton__mobile-filter-btn"></div>
        </div>
        <div class="catalog-toolbar__filters catalog-skeleton__toolbar-filters">
          <div class="catalog-toolbar__filters-inner">
            <div class="catalog-toolbar__group catalog-toolbar__group--grow">
              <div class="skeleton-block catalog-skeleton__toolbar-filter"></div>
              <div class="skeleton-block catalog-skeleton__toolbar-filter"></div>
              <div class="skeleton-block catalog-skeleton__toolbar-filter"></div>
            </div>
            <div class="catalog-toolbar__group">
              <div class="skeleton-block catalog-skeleton__toolbar-filter"></div>
            </div>
          </div>
        </div>
      </div>

      <section class="catalog-table-shell">
        <div class="catalog-table-shell__scroll">
          <div class="catalog-skeleton__rows">${desktopRows}</div>
        </div>
        <div class="catalog-mobile catalog-skeleton__mobile">${mobileCards}</div>
      </section>

      <div class="catalog-footer catalog-skeleton__footer" aria-hidden="true">
        <div class="skeleton-block catalog-skeleton__footer-summary"></div>
        <div class="skeleton-block catalog-skeleton__footer-controls"></div>
      </div>
    </section>
  `;
}

export function renderCatalogEmptyState(hasActiveFilters: boolean): string {
  const suggestion = hasActiveFilters
    ? "Try a different title, or loosen the format, season, and year filters."
    : "There are no mirrored entries to show right now. Check back after the next snapshot.";

  return `
    <div class="catalog-empty__panel" role="status">
      <div class="catalog-empty__icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </div>
      <h3 class="catalog-empty__title">No matching entries</h3>
      <p class="catalog-empty__text">${suggestion}</p>
      ${
        hasActiveFilters
          ? `<button class="catalog-empty__clear" type="button" data-empty-clear>Clear filters &amp; search</button>`
          : ""
      }
    </div>
  `;
}

export function renderFormatOptions(activeFormat: string) {
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

export function renderCatalogRow(item: CatalogItem) {
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

export function renderCatalogMobileCard(item: CatalogItem) {
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

export function buildSeasonOptions(items: CatalogIndexItem[]) {
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

export function buildYearOptions(items: CatalogIndexItem[]) {
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
