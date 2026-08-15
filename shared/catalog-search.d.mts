export type CatalogSearchableItem = {
  alId: number;
  searchText?: string | null;
  excerpt?: string | null;
  bestGroups?: readonly string[];
  altGroups?: readonly string[];
  titles?: {
    english?: string | null;
    userPreferred?: string | null;
    display?: string | null;
  } | null;
  startYear?: number | null;
  seasonYear?: number | null;
  format?: string | null;
  season?: string | null;
  status?: string | null;
  episodes?: number | null;
};

export type CompiledCatalogSearchQuery = Readonly<{
  normalized: string;
  compact: string;
  tokens: readonly string[];
  significantTokens: readonly string[];
  numericId: string | null;
}>;

export function normalizeCatalogSearchText(value: unknown): string;
export function compileCatalogSearchQuery(value: unknown): CompiledCatalogSearchQuery | null;
export function scoreCatalogSearchItem(
  item: CatalogSearchableItem,
  query: CompiledCatalogSearchQuery,
): number | null;
