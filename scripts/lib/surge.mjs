export const SURGE_CLI_VERSION = "0.41.2";
export const DEFAULT_SURGE_DOMAIN = "seadex.surge.sh";

export function normalizeSurgeDomain(value = DEFAULT_SURGE_DOMAIN) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    throw new Error("Surge domain must not be empty.");
  }

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch (error) {
    throw new Error(`Invalid Surge domain: ${raw}`, { cause: error });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported Surge domain protocol: ${url.protocol}`);
  }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Surge domain must be a bare hostname without credentials, port, path, query, or fragment.");
  }
  if (!isValidHostname(url.hostname)) {
    throw new Error(`Invalid Surge hostname: ${url.hostname}`);
  }

  return url.hostname;
}

export function surgeBaseUrl(value = DEFAULT_SURGE_DOMAIN) {
  return `https://${normalizeSurgeDomain(value)}`;
}

function isValidHostname(hostname) {
  if (hostname.length > 253 || hostname === "localhost") return false;
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  ));
}
