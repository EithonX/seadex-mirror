import type { CatalogIndexItem, CatalogItem } from "../../shared/mirror";
import { capitalize, formatCatalogFormat, formatDate } from "./format";
import { escapeHtml } from "./html";
import { renderDotsIcon } from "./icons";

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
