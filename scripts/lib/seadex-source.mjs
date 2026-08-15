import { fetchWithRetry, readJsonResponse, readTextResponse } from "./http.mjs";
import { validateSeaDexSnapshot } from "./source-integrity.mjs";
import { buildSeaDexFingerprint, sha256Json } from "./snapshot-integrity.mjs";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_LIST_IDS_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_GUARD_RESPONSE_BYTES = 512 * 1024;
const MAX_POCKETBASE_PAGE_SIZE = 500;
const PAGINATION_SAFETY_CEILING = 100_000;

export async function fetchConsistentSeaDexSnapshot(options) {
  const {
    sourceBaseUrl,
    pageSize,
    maxAttempts,
    retryLimit,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = options;

  const attempts = parsePositiveInteger(maxAttempts, "maxAttempts");
  validatePageSize(pageSize);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    log(`SeaDex capture attempt ${attempt}/${attempts}...`);

    const before = await fetchSeaDexMutationGuard({ sourceBaseUrl, retryLimit, fetchImpl });
    if (!guardIsInternallyConsistent(before)) {
      log(
        `SeaDex changed while reading the pre-capture guard (${before.listIds.length} listIDs vs ${before.entries.count} entry records); retrying.`,
      );
      continue;
    }

    const capture = await fetchSeaDexEntries({
      sourceBaseUrl,
      pageSize,
      retryLimit,
      maxResponseBytes,
      fetchImpl,
      log,
    });

    const after = await fetchSeaDexMutationGuard({ sourceBaseUrl, retryLimit, fetchImpl });
    if (!guardIsInternallyConsistent(after) || before.fingerprint !== after.fingerprint) {
      log("SeaDex changed while the entry/torrent collection was being captured; retrying the capture.");
      continue;
    }

    if (capture.totalItems !== after.entries.count) {
      throw new Error(
        `SeaDex parity failure: paginated entries reported ${capture.totalItems} rows but the stable entry guard reports ${after.entries.count}.`,
      );
    }

    validateSeaDexSnapshot(after.listIds, capture.entries);
    const seaDexFingerprint = buildSeaDexFingerprint(after.listIds, capture.entries);

    return {
      listIds: after.listIds,
      entries: capture.entries,
      seaDexFingerprint,
      sourceGuardFingerprint: after.fingerprint,
      captureAttempt: attempt,
    };
  }

  throw new Error(
    `SeaDex did not remain unchanged long enough to capture a consistent snapshot after ${attempts} attempt(s). Previous mirror retained.`,
  );
}

export async function fetchSeaDexMutationGuard(options) {
  const { sourceBaseUrl, retryLimit, fetchImpl = globalThis.fetch } = options;

  const [listIds, entries, torrents] = await Promise.all([
    fetchSeaDexListIds({ sourceBaseUrl, retryLimit, fetchImpl }),
    fetchSeaDexCollectionRevision({ sourceBaseUrl, collection: "entries", retryLimit, fetchImpl }),
    fetchSeaDexCollectionRevision({ sourceBaseUrl, collection: "torrents", retryLimit, fetchImpl }),
  ]);

  const fingerprint = sha256Json({ listIds, entries, torrents });
  return { listIds, entries, torrents, fingerprint };
}

export async function fetchSeaDexListIds(options) {
  const { sourceBaseUrl, retryLimit, fetchImpl = globalThis.fetch } = options;
  const endpoint = new URL("/api/listIDs", sourceBaseUrl);
  const response = await fetchWithRetry(
    endpoint,
    { headers: { accept: "text/plain" } },
    {
      retries: retryLimit,
      label: "SeaDex listIDs",
      fetchImpl,
    },
  );
  const text = await readTextResponse(response, {
    maxBytes: DEFAULT_MAX_LIST_IDS_BYTES,
    label: "SeaDex listIDs",
  });

  return parseSeaDexListIds(text);
}

export async function fetchSeaDexCollectionRevision(options) {
  const { sourceBaseUrl, collection, retryLimit, fetchImpl = globalThis.fetch } = options;
  if (collection !== "entries" && collection !== "torrents") {
    throw new Error(`Unsupported SeaDex revision collection: ${collection}`);
  }

  const endpoint = new URL(`/api/collections/${collection}/records`, sourceBaseUrl);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("perPage", "1");
  endpoint.searchParams.set("sort", "-updated,-id");
  endpoint.searchParams.set("skipTotal", "0");
  endpoint.searchParams.set("fields", "id,updated");

  const response = await fetchWithRetry(
    endpoint,
    { headers: { accept: "application/json" } },
    {
      retries: retryLimit,
      label: `SeaDex ${collection} revision`,
      fetchImpl,
    },
  );
  const payload = await readJsonResponse(response, {
    maxBytes: DEFAULT_MAX_GUARD_RESPONSE_BYTES,
    label: `SeaDex ${collection} revision`,
  });

  const count = parsePocketBaseCount(payload?.totalItems, `${collection}.totalItems`);
  const items = requireItemsArray(payload, `SeaDex ${collection} revision`);

  if (count === 0) {
    if (items.length !== 0) {
      throw new Error(`SeaDex ${collection} revision returned rows while totalItems is 0.`);
    }
    return { count: 0, latest: null };
  }

  if (items.length !== 1) {
    throw new Error(`SeaDex ${collection} revision expected one latest row but received ${items.length}.`);
  }

  const latest = items[0];
  if (typeof latest?.id !== "string" || latest.id.length === 0) {
    throw new Error(`SeaDex ${collection} revision latest row is missing an id.`);
  }
  if (typeof latest?.updated !== "string" || latest.updated.length === 0) {
    throw new Error(`SeaDex ${collection} revision latest row is missing an updated timestamp.`);
  }

  return {
    count,
    latest: {
      id: latest.id,
      updated: latest.updated,
    },
  };
}

export async function fetchSeaDexEntries(options) {
  const {
    sourceBaseUrl,
    pageSize,
    retryLimit,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    log = () => {},
  } = options;

  validatePageSize(pageSize);

  const endpoint = new URL("/api/collections/entries/records", sourceBaseUrl);
  const entries = [];
  let page = 1;
  let expectedTotalItems = null;
  let expectedTotalPages = null;

  while (true) {
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("perPage", String(pageSize));
    endpoint.searchParams.set("sort", "alID");
    endpoint.searchParams.set("skipTotal", page === 1 ? "0" : "1");
    endpoint.searchParams.set("expand", "trs");

    const response = await fetchWithRetry(
      endpoint,
      { headers: { accept: "application/json" } },
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
    const items = requireItemsArray(payload, `SeaDex entries page ${page}`);

    if (page === 1) {
      expectedTotalItems = parsePocketBaseCount(payload?.totalItems, "entries.totalItems");
      expectedTotalPages = parsePocketBaseCount(payload?.totalPages, "entries.totalPages");
      if (expectedTotalItems === 0 || expectedTotalPages === 0) {
        throw new Error("SeaDex records API returned an empty entries collection. Previous mirror retained.");
      }
      if (expectedTotalPages > PAGINATION_SAFETY_CEILING) {
        throw new Error(
          `SeaDex reported ${expectedTotalPages} pages, above the ${PAGINATION_SAFETY_CEILING}-page safety ceiling.`,
        );
      }
    }

    if (items.length === 0) {
      throw new Error(`SeaDex entries page ${page}/${expectedTotalPages} unexpectedly contained no rows.`);
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

  return { entries, totalItems: expectedTotalItems };
}

export function parseSeaDexListIds(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    throw new Error("SeaDex listIDs returned an empty ID list. Previous mirror retained.");
  }

  const ids = normalized.split(",").map((token) => {
    const trimmed = token.trim();
    if (!/^\d+$/u.test(trimmed)) {
      throw new Error(`SeaDex listIDs contains an invalid ID token: ${JSON.stringify(trimmed)}.`);
    }
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`SeaDex listIDs contains an invalid AniList ID: ${trimmed}.`);
    }
    return id;
  });

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new Error("SeaDex listIDs contains duplicate IDs.");
  }

  return [...ids].sort((left, right) => left - right);
}

function guardIsInternallyConsistent(guard) {
  return guard.entries.count === guard.listIds.length;
}

function requireItemsArray(payload, label) {
  if (!Array.isArray(payload?.items)) {
    throw new Error(`${label} did not contain a PocketBase items array.`);
  }
  return payload.items;
}

function parsePocketBaseCount(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`SeaDex records API returned an invalid ${fieldName} value.`);
  }
  return parsed;
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function validatePageSize(value) {
  const pageSize = parsePositiveInteger(value, "pageSize");
  if (pageSize > MAX_POCKETBASE_PAGE_SIZE) {
    throw new Error(`pageSize must be <= ${MAX_POCKETBASE_PAGE_SIZE} for the SeaDex PocketBase API.`);
  }
}
