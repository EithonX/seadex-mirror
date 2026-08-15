export const SEADEX_TRACKER_BASE_URLS: Readonly<Record<string, string>>;
export const SEADEX_PRIVATE_TRACKERS: readonly string[];

export function isSeaDexPrivateTracker(tracker: string | null | undefined): boolean;
export function resolveSeaDexTorrentUrl(
  tracker: string | null | undefined,
  value: string | null | undefined,
): string | null;

export type SeaDexTorrentLinkFields = {
  tracker?: string | null;
  sourceUrl?: string | null;
  url?: string | null;
  sourceGroupedUrl?: string | null;
  groupedUrl?: string | null;
};

export function resolveSeaDexTorrentActionUrl(
  torrent: SeaDexTorrentLinkFields | null | undefined,
  preferGrouped?: boolean,
): string | null;
