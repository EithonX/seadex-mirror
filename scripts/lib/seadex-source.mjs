import { fetchWithRetry, readJsonResponse } from "./http.mjs";
import { validateSeaDexSnapshot } from "./source-integrity.mjs";
import { buildSeaDexFingerprint } from "./snapshot-integrity.mjs";

export const SEADEX_USER_AGENT = "seadex-mirror/1.0 (static backup client)";
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const PAGINATION_SAFETY_CEILING = 100_000;

export async function fetchStableSeaDexSnapshot(options) {
  const {
    sourceBaseUrl,
    pageSize,
    requiredPasses,
    retryLimit,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = options;

  let previousFingerprint = null;
  let stablePasses = 0;
  let latest = null;
  const maxPasses = requiredPasses + 2;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    log(`SeaDex stability pass ${pass}/${maxPasses}...`);
    const sourceSnapshot = await fetchSeaDexSnapshot({
      sourceBaseUrl,
      pageSize,
      retryLimit,
      maxResponseBytes,
      fetchImpl,
      log,
    });
    validateSeaDexSnapshot(sourceSnapshot.entries);

    const listIds = sourceSnapshot.entries.map((entry) => entry.alID);
    const fingerprint = buildSeaDexFingerprint(listIds, sourceSnapshot.entries);
    latest = { listIds, entries: sourceSnapshot.entries, seaDexFingerprint: fingerprint };

    if (fingerprint === previousFingerprint) {
      stablePasses += 1;
    } else {
      stablePasses = 1;
      previousFingerprint = fingerprint;
    }

    if (stablePasses >= requiredPasses) {
      return latest;
    }

    if (pass < maxPasses) {
      log("SeaDex changed between reads; repeating until consecutive full snapshots agree.");
    }
  }

  throw new Error(
    `SeaDex did not produce ${requiredPasses} consecutive identical full snapshots after ${maxPasses} passes. Previous mirror retained.`,
  );
}

export async function fetchSeaDexSnapshot(options) {
  const {
    sourceBaseUrl,
    pageSize,
    retryLimit,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = options;

  const endpoint = new URL("/api/collections/entries/records", sourceBaseUrl);
  const entries = [];
  let page = 1;
  let expectedTotalItems = null;
  let expectedTotalPages = null;

  while (true) {
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("perPage", String(pageSize));
    endpoint.searchParams.set("sort", "-updated");
    endpoint.searchParams.set("skipTotal", page === 1 ? "0" : "1");
    endpoint.searchParams.set("expand", "trs");

    const response = await fetchWithRetry(
      endpoint,
      {
        headers: {
          accept: "application/json",
          "user-agent": SEADEX_USER_AGENT,
        },
      },
      {
        retries: retryLimit,
        label: `SeaDex entries page ${page}`,
        fetchImpl,
      },
    );
    const payload = await readJsonResponse(response, {
      maxBytes: maxResponseBytes,
      label: `SeaDex entries page ${page}`,
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];

    if (page === 1) {
      expectedTotalItems = parsePocketBaseCount(payload?.totalItems, "totalItems");
      expectedTotalPages = parsePocketBaseCount(payload?.totalPages, "totalPages");
      if (expectedTotalItems === null || expectedTotalPages === null) {
        throw new Error("SeaDex records API omitted PocketBase totalItems/totalPages metadata.");
      }
      if (expectedTotalItems === 0 || expectedTotalPages === 0) {
        throw new Error("SeaDex records API returned an empty collection. Previous mirror retained.");
      }
      if (expectedTotalPages > PAGINATION_SAFETY_CEILING) {
        throw new Error(
          `SeaDex reported ${expectedTotalPages} pages, above the ${PAGINATION_SAFETY_CEILING}-page safety ceiling.`,
        );
      }
    }

    entries.push(...items);
    log(
      `Fetched source page ${page}/${expectedTotalPages} with ${items.length} rows (${entries.length} accumulated).`,
    );

    if (page >= expectedTotalPages) {
      break;
    }

    page += 1;
    if (page > PAGINATION_SAFETY_CEILING) {
      throw new Error("SeaDex pagination exceeded the safety ceiling.");
    }
  }

  if (entries.length !== expectedTotalItems) {
    throw new Error(
      `SeaDex collection changed while paging: API reported ${expectedTotalItems} entries but ${entries.length} rows were received. Previous mirror retained.`,
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.alID) || entry.alID <= 0) {
      throw new Error("SeaDex entries response contains a row without a valid alID.");
    }
    if (seen.has(entry.alID)) {
      throw new Error(`SeaDex entries response contains duplicate AniList ID ${entry.alID}.`);
    }
    seen.add(entry.alID);
  }

  return { entries };
}

function parsePocketBaseCount(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`SeaDex records API returned an invalid ${fieldName} value.`);
  }
  return parsed;
}
