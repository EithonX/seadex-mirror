import type { EntryPayload, MirrorStatus } from "../../shared/mirror";
import {
  capitalize,
  formatBytes,
  formatCatalogFormat,
  formatDate,
  formatRelationType,
  formatSeriesLabel,
} from "./format";
import { escapeHtml } from "./html";
import {
  renderCalendarIcon,
  renderCalendarPlusIcon,
  renderCalendarUpIcon,
  renderFormatIcon,
  renderPrivateTrackerIcon,
  renderTrackerIcon,
} from "./icons";

const UPSTREAM_TRACKER_ORDER = [
  "Nyaa",
  "AB",
  "AniDex",
  "RuTracker",
  "AnimeTosho",
  "BeyondHD",
  "Aither",
  "Blutopia",
  "HDBits",
  "BroadcastTheNet",
  "PassThePopcorn",
  "Other",
  "OtherPrivate",
] as const;

type TorrentAction = {
  buttonLabel: string;
  menuLabel: string;
  href: string | null;
  tracker: string;
  isPrivate: boolean;
};

export function renderEntryContent(payload: EntryPayload, status: MirrorStatus): string {
  const entry = payload.entry;

  return `
    <main class="page page--entry">
      ${
        entry.incomplete
          ? `
          <div class="alert alert--danger">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <div class="alert__content">This entry is marked as incomplete.</div>
          </div>
        `
          : ""
      }
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
              ${
                entry.genres && entry.genres.length > 0
                  ? `
                  <div class="entry-genres">
                    ${entry.genres.slice(0, 4).map(g => `<span class="pill pill--tag">${escapeHtml(g)}</span>`).join("")}
                  </div>
                `
                  : ""
              }
              <div class="entry-meta-wrap">
                <div class="entry-meta-row">
                  <span>${renderCalendarIcon()} ${entry.season ? escapeHtml(capitalize(entry.season)) + " " : ""}${entry.seasonYear ?? entry.startYear ?? "Unknown"}</span>
                  <span>${escapeHtml(formatSeriesLabel(entry))} ${renderFormatIcon()}</span>
                </div>
                <div class="entry-meta-row">
                  <span title="Average Score"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-star"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> ${entry.averageScore ? `${entry.averageScore}%` : "No score"}</span>
                  <span title="Status">${entry.status ? escapeHtml(capitalize(entry.status.toLowerCase())) : "Unknown"} <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-activity"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>
                </div>
                <div class="entry-meta-row">
                  <span title="Created on">${renderCalendarPlusIcon()} ${formatDate(entry.sourceCreatedAt)}</span>
                  <span title="Updated on">${formatDate(entry.sourceUpdatedAt)} ${renderCalendarUpIcon()}</span>
                </div>
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
              ${renderTorrentCards(payload.torrents)}
            </div>
          </section>

          <hr class="section-divider" />

          <section class="content-section">
            <h2>Notes</h2>
            <div class="entry-notes">${escapeHtml(entry.notes || "No notes were included for this entry.")}</div>
          </section>

          ${renderRelationsSection(entry.relations)}
        </section>
      </div>

      <div class="entry-footer">
        <section class="content-section content-section--subtle">
          <div class="mirror-inline">
            <span>${status.counts.entries} mirrored entries</span>
            <span>Snapshot ${formatDate(status.sync.lastRebuildFinishedAt)}</span>
          </div>
        </section>
      </div>
    </main>
  `;
}

export function renderEntryLoading(): string {
  const skeletonBlock = (extraClass: string) => `<div class="skeleton-block ${extraClass}"></div>`;
  const metaRows = [0, 1, 2]
    .map(
      () => `
        <div class="entry-skeleton__meta-row">
          ${skeletonBlock("skeleton-line skeleton-line--meta")}
          ${skeletonBlock("skeleton-line skeleton-line--meta")}
        </div>
      `,
    )
    .join("");
  const chips = [0, 1, 2]
    .map(() => skeletonBlock("skeleton-chip"))
    .join("");
  const links = [0, 1]
    .map(() => skeletonBlock("skeleton-link"))
    .join("");
  const torrentCards = [0, 1, 2, 3]
    .map(
      () => `
        <div class="skeleton-torrent-card">
          ${skeletonBlock("skeleton-line skeleton-line--card-title")}
          <div class="skeleton-torrent-card__badges">
            ${skeletonBlock("skeleton-chip skeleton-chip--sm")}
            ${skeletonBlock("skeleton-chip skeleton-chip--sm")}
          </div>
          ${skeletonBlock("skeleton-torrent-card__action")}
        </div>
      `,
    )
    .join("");

  return `
    <div class="entry-skeleton" aria-busy="true">
      <span class="skeleton-sr">Loading mirrored entry...</span>
      <div class="entry-layout" aria-hidden="true">
        <aside class="entry-sidebar entry-skeleton__sidebar">
          ${skeletonBlock("skeleton-poster")}
          <div class="entry-skeleton__title">
            ${skeletonBlock("skeleton-line skeleton-line--title")}
            ${skeletonBlock("skeleton-line skeleton-line--subtitle")}
          </div>
          <div class="entry-skeleton__chips">${chips}</div>
          <div class="entry-skeleton__meta">${metaRows}</div>
          <div class="entry-skeleton__links">${links}</div>
        </aside>
        <section class="entry-main entry-skeleton__main">
          ${skeletonBlock("skeleton-line skeleton-heading")}
          <div class="skeleton-torrent-grid">${torrentCards}</div>
          ${skeletonBlock("skeleton-line skeleton-heading")}
          ${skeletonBlock("skeleton-notes")}
        </section>
      </div>
      <div class="entry-skeleton__footer">
        ${skeletonBlock("skeleton-line skeleton-line--footer")}
      </div>
    </div>
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

function renderTorrentCards(torrents: EntryPayload["torrents"]): string {
  if (!torrents || torrents.length === 0) {
    return "";
  }

  const groups = groupTorrentsLikeUpstream(torrents);
  const bestCards = groups
    .filter((group) => group.best.length > 0)
    .map((group) => renderTorrentCard(group.releaseGroupLabel, group.best))
    .join("");
  const altCards = groups
    .filter((group) => group.alt.length > 0)
    .map((group) => renderTorrentCard(group.releaseGroupLabel, group.alt))
    .join("");

  return bestCards + altCards;
}

function renderTorrentCard(groupName: string, torrents: EntryPayload["torrents"]): string {
  const summary = summarizeTorrentCard(torrents);
  const sizesHtml = summary.sizes.length
    ? `<p class="torrent-card-sizes">${summary.sizes.map((size) => `<span>${escapeHtml(size)}</span>`).join("")}</p>`
    : "";

  return `
    <article class="torrent-card">
      <div class="torrent-card__header">
        <h3>${escapeHtml(groupName)}</h3>
        ${sizesHtml}
      </div>

      <div class="torrent-card__badges">
        <span class="pill ${summary.isBest ? "pill--best" : "pill--alt"}">${summary.isBest ? "Best" : "Alt"}</span>
        ${summary.dualAudio ? `<span class="pill pill--audio">Dual Audio</span>` : ""}
        ${summary.tags.map((tag) => `<span class="pill pill--tag">${escapeHtml(tag)}</span>`).join("")}
      </div>

      <div class="torrent-card__actions">
        ${renderTorrentActionGroups(torrents)}
      </div>
    </article>
  `;
}

function renderTorrentActionGroups(torrents: EntryPayload["torrents"]): string {
  const groupedByTracker = new Map<string, EntryPayload["torrents"]>();

  for (const torrent of torrents) {
    const tracker = torrent.tracker || "Other";
    const trackerGroup = groupedByTracker.get(tracker);
    if (trackerGroup) {
      trackerGroup.push(torrent);
      continue;
    }

    groupedByTracker.set(tracker, [torrent]);
  }

  return [...groupedByTracker.entries()]
    .map(([tracker, trackerTorrents]) => renderTrackerTorrentActions(tracker, trackerTorrents))
    .join("");
}

function renderTrackerTorrentActions(tracker: string, torrents: EntryPayload["torrents"]): string {
  const actions = collectTrackerActions(tracker, torrents);
  if (actions.length === 0) {
    return "";
  }

  if (actions.length === 1) {
    return renderTrackerAction(actions[0]);
  }

  return renderTrackerActionMenu(tracker, actions);
}

function collectTrackerActions(tracker: string, torrents: EntryPayload["torrents"]) {
  const publicActions = new Map<string, TorrentAction>();
  let hasPrivate = false;

  for (const [index, torrent] of torrents.entries()) {
    const links = classifyTorrentLinks(torrent, true);
    if (links.publicUrl) {
      publicActions.set(links.publicUrl, {
        buttonLabel: tracker || "Other",
        menuLabel: describeTorrentAction(torrent, index),
        href: links.publicUrl,
        tracker,
        isPrivate: false,
      });
    }

    if (links.hasPrivate) {
      hasPrivate = true;
    }
  }

  if (publicActions.size > 0) {
    return [...publicActions.values()];
  }

  if (hasPrivate) {
    return [
      {
        buttonLabel: "Private Tracker",
        menuLabel: "Private Tracker",
        href: null,
        tracker,
        isPrivate: true,
      },
    ];
  }

  return [
    {
      buttonLabel: tracker || "Other",
      menuLabel: tracker || "Other",
      href: null,
      tracker,
      isPrivate: false,
    },
  ];
}

function renderTrackerAction(action: TorrentAction): string {
  const label = escapeHtml(action.buttonLabel);

  if (action.href) {
    return `<a class="torrent-button" href="${escapeHtml(action.href)}" target="_blank" rel="noreferrer">${renderTrackerIcon(action.tracker || action.buttonLabel)} ${label}</a>`;
  }

  if (action.isPrivate) {
    return `<span class="torrent-button torrent-button--private" aria-disabled="true">${renderPrivateTrackerIcon()} ${label}</span>`;
  }

  return `<span class="torrent-button torrent-button--muted">${label}</span>`;
}

function renderTrackerActionMenu(tracker: string, actions: TorrentAction[]): string {
  const firstAction = actions[0];
  if (!firstAction) {
    return "";
  }

  const summaryLabel = firstAction.isPrivate ? "Private Tracker" : tracker || "Other";
  const summaryIcon = firstAction.isPrivate
    ? renderPrivateTrackerIcon()
    : renderTrackerIcon(firstAction.tracker || summaryLabel);

  return `
    <details class="torrent-menu">
      <summary class="torrent-button torrent-menu__summary">${summaryIcon} ${escapeHtml(summaryLabel)}</summary>
      <div class="torrent-menu__panel">
        ${actions.map((action) => renderTrackerActionMenuItem(action)).join("")}
      </div>
    </details>
  `;
}

function renderTrackerActionMenuItem(action: TorrentAction) {
  const label = escapeHtml(action.menuLabel);

  if (action.href) {
    return `<a class="torrent-menu__item" href="${escapeHtml(action.href)}" target="_blank" rel="noreferrer">${label}</a>`;
  }

  if (action.isPrivate) {
    return `<span class="torrent-menu__item torrent-menu__item--private">${label}</span>`;
  }

  return `<span class="torrent-menu__item torrent-menu__item--muted">${label}</span>`;
}

function describeTorrentAction(torrent: EntryPayload["torrents"][number], index: number) {
  const totalSize = torrent.files.reduce((sum, file) => sum + (Number.isFinite(file.length) ? file.length : 0), 0);
  const fileCount = torrent.files.length;

  if (fileCount === 0 && totalSize <= 0) {
    return `Torrent ${index + 1}`;
  }

  const sizeLabel = totalSize > 0 ? formatBytes(totalSize) : "Unknown size";
  const fileLabel = fileCount === 1 ? "1 file" : `${fileCount} files`;
  return `${fileLabel} - ${sizeLabel}`;
}

function summarizeTorrentCard(torrents: EntryPayload["torrents"]) {
  let isBest = false;
  let dualAudio = false;
  const tags = new Set<string>();
  const trackerSizes = new Map<string, number>();

  for (const torrent of torrents) {
    if (torrent.isBest) {
      isBest = true;
    }
    if (torrent.dualAudio) {
      dualAudio = true;
    }
    for (const tag of torrent.tags) {
      tags.add(tag);
    }

    const size = torrent.files.reduce(
      (total, file) => total + (Number.isFinite(file.length) ? file.length : 0),
      0,
    );
    if (size > 0) {
      trackerSizes.set(torrent.tracker, (trackerSizes.get(torrent.tracker) ?? 0) + size);
    }
  }

  return {
    isBest,
    dualAudio,
    tags: [...tags].slice(0, 4),
    sizes: [...trackerSizes.values()].map((size) => formatBytes(size)),
  };
}

function groupTorrentsLikeUpstream(torrents: EntryPayload["torrents"]) {
  const groups = new Map<
    string,
    {
      releaseGroupLabel: string;
      best: EntryPayload["torrents"];
      alt: EntryPayload["torrents"];
    }
  >();

  for (const torrent of sortTorrentsLikeUpstream(torrents)) {
    const releaseGroupKey = (torrent.releaseGroup || "").trim();
    const group = groups.get(releaseGroupKey);
    if (group) {
      (torrent.isBest ? group.best : group.alt).push(torrent);
      continue;
    }

    groups.set(releaseGroupKey, {
      releaseGroupLabel: releaseGroupKey || "Unknown group",
      best: torrent.isBest ? [torrent] : [],
      alt: torrent.isBest ? [] : [torrent],
    });
  }

  return [...groups.values()];
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

function classifyTorrentLinks(torrent: EntryPayload["torrents"][number], preferGrouped = false) {
  const candidates = (
    preferGrouped
      ? [torrent.groupedUrl, torrent.sourceGroupedUrl, torrent.url, torrent.sourceUrl]
      : [torrent.url, torrent.sourceUrl, torrent.groupedUrl, torrent.sourceGroupedUrl]
  ).filter(Boolean) as string[];
  const publicUrl = candidates.find((url) => !isPrivateTrackerUrl(url)) ?? null;
  const privateUrl = candidates.find((url) => isPrivateTrackerUrl(url)) ?? null;
  const trackerIsPrivate = isPrivateTrackerName(torrent.tracker);

  return {
    publicUrl,
    publicLabel: publicUrl ? renderTrackerLabel(publicUrl) : "Public",
    hasPrivate: Boolean(privateUrl || trackerIsPrivate),
  };
}

function isPrivateTrackerUrl(url: string) {
  return /\/torrents\.php\?/i.test(url) || /releases\.moe\/torrents\.php/i.test(url);
}

function isPrivateTrackerName(tracker: string | null | undefined) {
  const normalized = (tracker ?? "").trim();
  return normalized === "AB" || normalized === "OtherPrivate";
}

function sortTorrentsLikeUpstream(torrents: EntryPayload["torrents"]) {
  return torrents.slice().sort(compareTorrentsLikeUpstream);
}

function compareTorrentsLikeUpstream(
  left: EntryPayload["torrents"][number],
  right: EntryPayload["torrents"][number],
) {
  return (
    compareNumbers(right.isBest ? 1 : 0, left.isBest ? 1 : 0) ||
    compareNumbers(left.dualAudio ? 1 : 0, right.dualAudio ? 1 : 0) ||
    compareNumbers(trackerPriorityIndex(left.tracker), trackerPriorityIndex(right.tracker)) ||
    compareStrings((left.releaseGroup ?? "").toLowerCase(), (right.releaseGroup ?? "").toLowerCase()) ||
    compareStrings(left.id ?? "", right.id ?? "")
  );
}

function trackerPriorityIndex(tracker: string) {
  const index = UPSTREAM_TRACKER_ORDER.indexOf(tracker as (typeof UPSTREAM_TRACKER_ORDER)[number]);
  return index === -1 ? UPSTREAM_TRACKER_ORDER.length : index;
}

function compareNumbers(left: number, right: number) {
  return left - right;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
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

export function renderEntryNotFound(alId: number) {
  return `
    <main class="page page--error">
      <div class="error-panel">
        <div class="error-panel__badge">404</div>
        <div class="error-panel__icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search-x"><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        </div>
        <h1>Entry Not Found</h1>
        <p>We couldn't find a mirrored entry for ID <strong>${alId}</strong> in our catalog database. It may not be tracked yet or was removed.</p>
        <div class="error-panel__actions">
          <a class="comparison-link" href="/">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-left"><path d="m12 19-7-7 7-7"/><path d="M5 12h14"/></svg>
            <span>Return to Catalog</span>
          </a>
        </div>
      </div>
    </main>
  `;
}

export function renderEntryError(alId: number, message: string) {
  return `
    <main class="page page--error">
      <div class="error-panel">
        <div class="error-panel__badge error-panel__badge--error">ERROR</div>
        <div class="error-panel__icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-alert"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12" y1="16" y2="16"/></svg>
        </div>
        <h1>Failed to Load Entry</h1>
        <p>${escapeHtml(message)}</p>
        <div class="error-panel__actions">
          <button class="comparison-link" type="button" data-entry-retry>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            <span>Retry Loading</span>
          </button>
          <a class="comparison-link comparison-link--secondary" href="/">
            <span>Return to Catalog</span>
          </a>
        </div>
      </div>
    </main>
  `;
}
