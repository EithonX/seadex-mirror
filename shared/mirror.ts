export type MirrorStatus = {
  mirror: {
    sourceBaseUrl: string;
    originalSite: string;
    attribution: string;
    disclaimer: string;
  };
  counts: {
    entries: number;
    torrents: number;
    anilistMedia: number;
  };
  integrity: {
    entriesWithoutTorrents: number;
    entriesWithoutAniList: number;
    sourceListIdCount: number;
    sourceEntryCount: number;
    sourceTorrentCount: number;
    listIdParity: string | null;
    expandedTorrentParity: string | null;
  };
  sync: {
    lastRebuildStartedAt: string | null;
    lastRebuildFinishedAt: string | null;
    lastRebuildMode: string | null;
    lastError: string | null;
    summary: Record<string, unknown> | null;
  };
};

export type CatalogItem = {
  alId: number;
  recordId: string;
  comparisonLinks: string[];
  excerpt: string | null;
  incomplete: boolean;
  sourceUpdatedAt: string;
  bestGroups: string[];
  altGroups: string[];
  titles: {
    userPreferred: string | null;
    english: string | null;
    display: string;
  };
  coverImage: {
    extraLarge: string | null;
    color: string | null;
  };
  season: string | null;
  seasonYear: number | null;
  startYear: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  averageScore: number | null;
  torrentCount: number;
  bestTorrentCount: number;
};

export type CatalogIndexItem = CatalogItem & {
  searchText: string;
};

export type CatalogIndexPayload = {
  generatedAt: string;
  items: CatalogIndexItem[];
};

export type CatalogPayload = {
  filters: {
    search: string;
    format: string | null;
    sort: CatalogSort;
    order: CatalogSortOrder;
    limit: number;
    offset: number;
  };
  pagination: {
    count: number;
    total: number;
    nextOffset: number | null;
  };
  items: CatalogItem[];
};

export type SheetItem = {
  alId: number;
  recordId: string;
  title: string;
  format: string | null;
  status: string | null;
  year: number | null;
  episodes: number | null;
  averageScore: number | null;
  incomplete: boolean;
  comparisonCount: number;
  torrentCount: number;
  bestCount: number;
  altCount: number;
  bestGroups: string[];
  altGroups: string[];
  excerpt: string | null;
  updatedAt: string;
  searchText: string;
};

export type SheetPayload = {
  generatedAt: string;
  items: SheetItem[];
};

export type SheetWorkbookRichTextRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string | null;
  fontName?: string | null;
  fontSize?: number | null;
  hyperlink?: string | null;
};

export type SheetWorkbookBorderStyle = {
  style: string;
  color?: string | null;
};

export type SheetWorkbookCellStyle = {
  fontName?: string | null;
  fontSize?: number | null;
  fontWeight?: number | null;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  textColor?: string | null;
  backgroundColor?: string | null;
  horizontalAlign?: string | null;
  verticalAlign?: string | null;
  wrap?: boolean;
  borderTop?: SheetWorkbookBorderStyle | null;
  borderRight?: SheetWorkbookBorderStyle | null;
  borderBottom?: SheetWorkbookBorderStyle | null;
  borderLeft?: SheetWorkbookBorderStyle | null;
};

export type SheetWorkbookCell = {
  col: number;
  address: string;
  display: string;
  styleId: number;
  richText?: SheetWorkbookRichTextRun[];
  hyperlink?: string | null;
};

export type SheetWorkbookRow = {
  index: number;
  height?: number | null;
  hidden?: boolean;
  outlineLevel?: number;
  cells: SheetWorkbookCell[];
};

export type SheetWorkbookColumn = {
  index: number;
  letter: string;
  width?: number | null;
  hidden?: boolean;
  outlineLevel?: number;
};

export type SheetWorkbookMerge = {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
};

export type SheetWorkbookImage = {
  mediaId: string;
  col: number;
  row: number;
  offsetX?: number;
  offsetY?: number;
  width: number;
  height: number;
};

export type SheetWorkbookMedia = {
  id: string;
  mimeType: string;
  dataUrl: string;
};

export type SheetWorkbookSheet = {
  id: number;
  name: string;
  slug: string;
  tabColor?: string | null;
  rowCount: number;
  columnCount: number;
  defaultRowHeight?: number | null;
  defaultColumnWidth?: number | null;
  frozenRows?: number;
  frozenColumns?: number;
  columns: SheetWorkbookColumn[];
  rows: SheetWorkbookRow[];
  merges: SheetWorkbookMerge[];
  images: SheetWorkbookImage[];
};

export type SheetWorkbookPayload = {
  generatedAt: string;
  credit: {
    label: string;
    url?: string | null;
  } | null;
  styles: SheetWorkbookCellStyle[];
  media: SheetWorkbookMedia[];
  sheets: SheetWorkbookSheet[];
};

export type EntryPayload = {
  source: {
    originalSite: string;
    originalEntryUrl: string;
  };
  entry: {
    alId: number;
    recordId: string;
    comparisonLinks: string[];
    notes: string;
    theoreticalBest: string | null;
    incomplete: boolean;
    sourceCreatedAt: string;
    sourceUpdatedAt: string;
    torrentCount: number;
    bestTorrentCount: number;
    titles: {
      userPreferred: string | null;
      english: string | null;
      display: string;
    };
    coverImage: {
      extraLarge: string | null;
      color: string | null;
    };
    season: string | null;
    seasonYear: number | null;
    startYear: number | null;
    format: string | null;
    status: string | null;
    episodes: number | null;
    duration: number | null;
    averageScore: number | null;
    genres: string[];
    relations: Array<{
      relationType?: string | null;
      node?: {
        id?: number;
        title?: { userPreferred?: string | null; english?: string | null };
        coverImage?: { extraLarge?: string | null; color?: string | null };
        seasonYear?: number | null;
        startDate?: { year?: number | null };
        format?: string | null;
        status?: string | null;
        type?: string | null;
        episodes?: number | null;
      };
    }>;
  };
  torrents: Array<{
    id: string;
    releaseGroup: string;
    tracker: string;
    sourceUrl: string | null;
    url: string | null;
    sourceGroupedUrl: string | null;
    groupedUrl: string | null;
    infoHash: string | null;
    dualAudio: boolean;
    isBest: boolean;
    tags: string[];
    files: Array<{ length: number; name: string }>;
    sourceUpdatedAt: string;
  }>;
};

export type CatalogSort = "updated" | "title" | "format" | "year" | "episodes" | "score";

export type CatalogSortOrder = "asc" | "desc";

export function filterCatalogItems(
  items: CatalogIndexItem[],
  input: {
    search?: string | null;
    format?: string | null;
    sort?: string | null;
    order?: string | null;
    limit?: number | null;
    offset?: number | null;
  },
): CatalogPayload {
  const search = (input.search ?? "").trim();
  const format = normalizeFormat(input.format ?? "");
  const sort = normalizeCatalogSort(input.sort ?? "updated");
  const order = normalizeCatalogSortOrder(input.order, sort);
  const limit = clampInt(input.limit, 24, 1, 100);
  const offset = clampInt(input.offset, 0, 0, 5000);
  const lowerSearch = search.toLowerCase();

  let filtered = items;
  if (lowerSearch) {
    filtered = filtered.filter((item) => item.searchText.includes(lowerSearch));
  }

  if (format) {
    filtered = filtered.filter((item) => (item.format ?? "").toUpperCase() === format);
  }

  const sorted = [...filtered].sort((left, right) => compareCatalogItems(left, right, sort, order));
  const sliced = sorted.slice(offset, offset + limit);
  const pageItems = sliced.map(stripSearchText);
  const nextOffset = offset + limit < sorted.length ? offset + limit : null;

  return {
    filters: {
      search,
      format,
      sort,
      order,
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

export function clampInt(
  value: number | string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : value === null || value === undefined
        ? Number.NaN
        : Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function stripSearchText(item: CatalogIndexItem): CatalogItem {
  const { searchText: _searchText, ...catalogItem } = item;
  return catalogItem;
}

function normalizeFormat(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

export function normalizeCatalogSort(value: string | null | undefined): CatalogSort {
  switch (value) {
    case "title":
    case "format":
    case "year":
    case "episodes":
    case "score":
      return value;
    default:
      return "updated";
  }
}

export function defaultSortOrder(sort: CatalogSort): CatalogSortOrder {
  switch (sort) {
    case "title":
    case "format":
      return "asc";
    default:
      // updated, year, episodes, score
      return "desc";
  }
}

export function normalizeCatalogSortOrder(
  value: string | null | undefined,
  sort: CatalogSort,
): CatalogSortOrder {
  if (value === "asc" || value === "desc") {
    return value;
  }
  return defaultSortOrder(sort);
}

function compareCatalogItems(
  left: CatalogIndexItem,
  right: CatalogIndexItem,
  sort: CatalogSort,
  order: CatalogSortOrder,
): number {
  const direction = order === "asc" ? 1 : -1;

  switch (sort) {
    case "title": {
      const primary = compareStrings(catalogTitle(left), catalogTitle(right));
      // Stable tie-breaker: alId ascending.
      return direction * primary || compareNumbers(left.alId, right.alId);
    }
    case "format": {
      const primary = compareStrings(catalogFormat(left), catalogFormat(right));
      return direction * primary || compareUpdatedThenAlIdDesc(left, right);
    }
    case "year": {
      const primary = compareNumbers(catalogYear(left), catalogYear(right));
      return direction * primary || compareUpdatedThenAlIdDesc(left, right);
    }
    case "episodes": {
      const primary = compareNumbers(catalogEpisodes(left), catalogEpisodes(right));
      return direction * primary || compareUpdatedThenAlIdDesc(left, right);
    }
    case "score": {
      const primary = compareNumbers(left.averageScore ?? 0, right.averageScore ?? 0);
      return direction * primary || compareUpdatedThenAlIdDesc(left, right);
    }
    default: {
      const primary = compareNumbers(Date.parse(left.sourceUpdatedAt), Date.parse(right.sourceUpdatedAt));
      // Stable tie-breaker: alId descending.
      return direction * primary || compareNumbers(right.alId, left.alId);
    }
  }
}

// Shared tie-breaker for non-updated / non-title sorts: newest update first, then newest alId.
function compareUpdatedThenAlIdDesc(left: CatalogIndexItem, right: CatalogIndexItem): number {
  return (
    compareNumbers(Date.parse(right.sourceUpdatedAt), Date.parse(left.sourceUpdatedAt)) ||
    compareNumbers(right.alId, left.alId)
  );
}

function catalogTitle(item: CatalogItem): string {
  return (item.titles.english ?? item.titles.userPreferred ?? String(item.alId)).toLowerCase();
}

function catalogFormat(item: CatalogItem): string {
  return (item.format ?? "").toUpperCase();
}

function catalogYear(item: CatalogItem): number {
  return item.startYear ?? item.seasonYear ?? 0;
}

function catalogEpisodes(item: CatalogItem): number {
  return item.episodes ?? 0;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}
