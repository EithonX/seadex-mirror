import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchConsistentSeaDexSnapshot,
  fetchSeaDexCollectionRevision,
  fetchSeaDexEntries,
  fetchSeaDexListIds,
  fetchSeaDexMutationGuard,
  isSeaDexMutationGuardInternallyConsistent,
  parseSeaDexListIds,
} from "../scripts/lib/seadex-source.mjs";

function torrent(id, updated = "2026-08-15 00:00:00.000Z") {
  return { id, updated };
}

function entry(alID, torrentIds = [], updated = "2026-08-15 00:00:00.000Z") {
  return {
    id: `entry-${alID}`,
    alID,
    trs: torrentIds,
    expand: { trs: torrentIds.map((id) => torrent(id)) },
    updated,
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(value) {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function revisionResponse(count, id, updated) {
  return jsonResponse({
    page: 1,
    perPage: 1,
    totalItems: count,
    totalPages: count > 0 ? count : 0,
    items: count > 0 ? [{ id, updated }] : [],
  });
}

function createStableSourceFetch({ entries, torrentCount = 0, revision = "2026-08-15 00:00:00.000Z" }) {
  const sortedEntries = [...entries].sort((left, right) => left.alID - right.alID);
  return async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("user-agent"), false);

    if (url.pathname === "/api/listIDs") {
      return textResponse(sortedEntries.map((item) => item.alID).join(","));
    }

    if (url.pathname === "/api/collections/torrents/records") {
      assert.equal(url.searchParams.get("sort"), "-updated,-id");
      return revisionResponse(torrentCount, "torrent-latest", revision);
    }

    if (url.pathname === "/api/collections/entries/records" && url.searchParams.get("perPage") === "1") {
      assert.equal(url.searchParams.get("sort"), "-updated,-id");
      return revisionResponse(sortedEntries.length, sortedEntries.at(-1)?.id ?? "", revision);
    }

    if (url.pathname === "/api/collections/entries/records") {
      assert.equal(url.searchParams.get("sort"), "alID");
      assert.equal(url.searchParams.get("expand"), "trs");
      const perPage = Number(url.searchParams.get("perPage"));
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * perPage;
      const items = sortedEntries.slice(start, start + perPage);
      const totalPages = Math.ceil(sortedEntries.length / perPage);
      return jsonResponse({
        page,
        perPage,
        totalItems: page === 1 ? sortedEntries.length : -1,
        totalPages: page === 1 ? totalPages : -1,
        items,
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };
}

test("SeaDex listIDs uses the first-party route and does not impersonate a browser", async () => {
  const requested = [];
  const fetchImpl = async (input, init) => {
    requested.push({ url: new URL(input), headers: new Headers(init?.headers) });
    return textResponse("3,1,2");
  };

  const ids = await fetchSeaDexListIds({
    sourceBaseUrl: "https://releases.moe",
    retryLimit: 0,
    fetchImpl,
  });

  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url.pathname, "/api/listIDs");
  assert.equal(requested[0].headers.get("accept"), "text/plain");
  assert.equal(requested[0].headers.has("user-agent"), false);
});

test("SeaDex listIDs rejects empty, malformed, and duplicate IDs", () => {
  assert.throws(() => parseSeaDexListIds(""), /empty ID list/);
  assert.throws(() => parseSeaDexListIds("1,nope,2"), /invalid ID token/);
  assert.throws(() => parseSeaDexListIds("1,1"), /duplicate IDs/);
  assert.throws(() => parseSeaDexListIds("0,1"), /invalid AniList ID/);
});

test("SeaDex collection revision captures count plus deterministic latest mutation", async () => {
  const requested = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requested.push(url);
    return revisionResponse(17, "latest-record", "2026-08-15 03:04:05.000Z");
  };

  const revision = await fetchSeaDexCollectionRevision({
    sourceBaseUrl: "https://releases.moe",
    collection: "torrents",
    retryLimit: 0,
    fetchImpl,
  });

  assert.deepEqual(revision, {
    count: 17,
    latest: { id: "latest-record", updated: "2026-08-15 03:04:05.000Z" },
  });
  assert.equal(requested[0].pathname, "/api/collections/torrents/records");
  assert.equal(requested[0].searchParams.get("perPage"), "1");
  assert.equal(requested[0].searchParams.get("sort"), "-updated,-id");
  assert.equal(requested[0].searchParams.get("skipTotal"), "0");
  assert.equal(requested[0].searchParams.get("fields"), "id,updated");
});

test("SeaDex entry crawl uses deterministic alID pagination with expanded torrents", async () => {
  const requested = [];
  const rows = [entry(1, ["a"]), entry(2), entry(3, ["b"])];
  const baseFetch = createStableSourceFetch({ entries: rows, torrentCount: 2 });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/collections/entries/records" && url.searchParams.get("perPage") !== "1") {
      requested.push(url);
    }
    return baseFetch(input, init);
  };

  const snapshot = await fetchSeaDexEntries({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 2,
    retryLimit: 0,
    fetchImpl,
  });

  assert.deepEqual(snapshot.entries.map((item) => item.alID), [1, 2, 3]);
  assert.equal(snapshot.totalItems, 3);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].searchParams.get("skipTotal"), "0");
  assert.equal(requested[1].searchParams.get("skipTotal"), "1");
  assert.ok(requested.every((url) => url.searchParams.get("sort") === "alID"));
  assert.ok(requested.every((url) => url.searchParams.get("expand") === "trs"));
});

test("SeaDex entry crawl rejects an incomplete paginated collection", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      page: 1,
      perPage: 100,
      totalItems: 2,
      totalPages: 1,
      items: [entry(1)],
    });

  await assert.rejects(
    fetchSeaDexEntries({
      sourceBaseUrl: "https://releases.moe",
      pageSize: 100,
      retryLimit: 0,
      fetchImpl,
    }),
    /reported 2 entries but 1 rows were received/,
  );
});

test("SeaDex mutation guard consistency requires listIDs and entry counts to agree", async () => {
  const fetchImpl = createStableSourceFetch({ entries: [entry(1), entry(2)], torrentCount: 0 });
  const guard = await fetchSeaDexMutationGuard({
    sourceBaseUrl: "https://releases.moe",
    retryLimit: 0,
    fetchImpl,
  });

  assert.equal(isSeaDexMutationGuardInternallyConsistent(guard), true);
  assert.equal(
    isSeaDexMutationGuardInternallyConsistent({ ...guard, entries: { ...guard.entries, count: 1 } }),
    false,
  );
});

test("SeaDex consistent capture can reuse a preflight guard without weakening the post-crawl check", async () => {
  const rows = [entry(1, ["a"]), entry(2, ["b"])];
  const baseFetch = createStableSourceFetch({ entries: rows, torrentCount: 2 });
  let listIdCalls = 0;
  let fullEntryPages = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/listIDs") listIdCalls += 1;
    if (url.pathname === "/api/collections/entries/records" && url.searchParams.get("perPage") !== "1") {
      fullEntryPages += 1;
    }
    return baseFetch(input, init);
  };

  const initialGuard = await fetchSeaDexMutationGuard({
    sourceBaseUrl: "https://releases.moe",
    retryLimit: 0,
    fetchImpl,
  });
  listIdCalls = 0;

  const snapshot = await fetchConsistentSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 500,
    maxAttempts: 4,
    retryLimit: 0,
    fetchImpl,
    initialGuard,
  });

  assert.equal(snapshot.captureAttempt, 1);
  assert.equal(fullEntryPages, 1);
  assert.equal(listIdCalls, 1, "only the mandatory post-crawl guard should be fetched");
  assert.equal(snapshot.sourceGuard.fingerprint, initialGuard.fingerprint);
});

test("SeaDex consistent capture performs one full crawl when before/after guards match", async () => {
  const rows = [entry(1, ["a"]), entry(2, ["b"])];
  let fullEntryPages = 0;
  const baseFetch = createStableSourceFetch({ entries: rows, torrentCount: 2 });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/collections/entries/records" && url.searchParams.get("perPage") !== "1") {
      fullEntryPages += 1;
    }
    return baseFetch(input, init);
  };

  const snapshot = await fetchConsistentSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 500,
    maxAttempts: 4,
    retryLimit: 0,
    fetchImpl,
  });

  assert.equal(snapshot.captureAttempt, 1);
  assert.equal(fullEntryPages, 1);
  assert.deepEqual(snapshot.listIds, [1, 2]);
  assert.equal(snapshot.entries.length, 2);
  assert.match(snapshot.seaDexFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(snapshot.sourceGuardFingerprint, /^[a-f0-9]{64}$/u);
});

test("SeaDex consistent capture retries the full crawl when a mutation occurs mid-capture", async () => {
  const oldRows = [entry(1, ["old"], "2026-08-15 00:00:00.000Z")];
  const newRows = [entry(1, ["new"], "2026-08-15 00:01:00.000Z")];
  let guardNumber = 0;
  let fullCrawls = 0;
  let activeRows = oldRows;

  const fetchImpl = async (input) => {
    const url = new URL(input);

    if (url.pathname === "/api/listIDs") {
      guardNumber += 1;
      if (guardNumber >= 2) {
        activeRows = newRows;
      }
      return textResponse("1");
    }

    if (url.pathname === "/api/collections/torrents/records") {
      const isNew = guardNumber >= 2;
      return revisionResponse(1, "torrent-1", isNew ? "2026-08-15 00:01:00.000Z" : "2026-08-15 00:00:00.000Z");
    }

    if (url.pathname === "/api/collections/entries/records" && url.searchParams.get("perPage") === "1") {
      const isNew = guardNumber >= 2;
      return revisionResponse(1, "entry-1", isNew ? "2026-08-15 00:01:00.000Z" : "2026-08-15 00:00:00.000Z");
    }

    if (url.pathname === "/api/collections/entries/records") {
      fullCrawls += 1;
      return jsonResponse({ page: 1, perPage: 500, totalItems: 1, totalPages: 1, items: activeRows });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const snapshot = await fetchConsistentSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 500,
    maxAttempts: 4,
    retryLimit: 0,
    fetchImpl,
  });

  assert.equal(snapshot.captureAttempt, 2);
  assert.equal(fullCrawls, 2);
  assert.equal(snapshot.entries[0].trs[0], "new");
});

test("SeaDex consistent capture retries a guard whose ID count disagrees with PocketBase", async () => {
  let listCall = 0;
  const rows = [entry(1)];
  const baseFetch = createStableSourceFetch({ entries: rows });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/api/listIDs") {
      listCall += 1;
      return textResponse(listCall === 1 ? "1,2" : "1");
    }
    return baseFetch(input, init);
  };

  const snapshot = await fetchConsistentSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 500,
    maxAttempts: 3,
    retryLimit: 0,
    fetchImpl,
  });

  assert.equal(snapshot.captureAttempt, 2);
  assert.deepEqual(snapshot.listIds, [1]);
});

test("SeaDex consistent capture validates exact trs versus expand.trs parity after a stable guard", async () => {
  const broken = entry(1, ["linked"]);
  broken.expand.trs = [torrent("different")];
  const fetchImpl = createStableSourceFetch({ entries: [broken], torrentCount: 1 });

  await assert.rejects(
    fetchConsistentSeaDexSnapshot({
      sourceBaseUrl: "https://releases.moe",
      pageSize: 500,
      maxAttempts: 2,
      retryLimit: 0,
      fetchImpl,
    }),
    /torrent parity failure/,
  );
});
