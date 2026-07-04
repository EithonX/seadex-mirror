import type { EntryPayload } from "../../shared/mirror";

export function formatSeriesLabel(entry: EntryPayload["entry"]) {
  const format = formatCatalogFormat(entry.format);
  const episodes = entry.episodes ?? "?";
  return `${format} (${episodes})`;
}

export function formatCatalogFormat(format: string | null | undefined) {
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

export function formatDate(value: string | null) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

export function formatBytes(value: number) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return "0 B";
  }

  if (value < 1) {
    return `${value} B`;
  }

  const units = [" B", " KiB", " MiB", " GiB", " TiB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${Number((value / Math.pow(1024, unitIndex)).toFixed(2))}${units[unitIndex]}`;
}

export function formatRelationType(value: string | null | undefined) {
  if (!value) {
    return "related";
  }
  return value.toLowerCase().replaceAll("_", " ");
}

export function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
