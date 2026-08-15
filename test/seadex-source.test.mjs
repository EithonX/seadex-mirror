import assert from "node:assert/strict";
import test from "node:test";
import { fetchSeaDexSnapshot, fetchStableSeaDexSnapshot, SEADEX_USER_AGENT } from "../scripts/lib/seadex-source.mjs";

function torrent(id) {
  return { id };
}

function entry(alID, torrentIds = []) {
  return {
    alID,
    trs: torrentIds,
    expand: { trs: torrentIds.map(torrent) },
    updated: "2026-08-15 00:00:00.000Z",
  };
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("SeaDex source reads the canonical records collection without listIDs", async () => {
  const requested = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requested.push({ url, headers: new Headers(init?.headers) });
    const page = Number(url.searchParams.get("page"));

    if (page === 1) {
      return jsonResponse({
        page: 1,
        perPage: 2,
        totalItems: 3,
        totalPages: 2,
        items: [entry(1, ["a"]), entry(2)],
      });
    }
    return jsonResponse({ page: 2, perPage: 2, items: [entry(3, ["b"])] });
  };

  const snapshot = await fetchSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 2,
    retryLimit: 0,
    fetchImpl,
  });

  assert.deepEqual(snapshot.entries.map((item) => item.alID), [1, 2, 3]);
  assert.equal(requested.length, 2);
  assert.ok(requested.every(({ url }) => url.pathname === "/api/collections/entries/records"));
  assert.ok(requested.every(({ url }) => !url.pathname.includes("listIDs")));
  assert.equal(requested[0].url.searchParams.get("skipTotal"), "0");
  assert.equal(requested[1].url.searchParams.get("skipTotal"), "1");
  assert.equal(requested[0].headers.get("user-agent"), SEADEX_USER_AGENT);
});

test("SeaDex source rejects an incomplete paginated collection", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      page: 1,
      perPage: 100,
      totalItems: 2,
      totalPages: 1,
      items: [entry(1)],
    });

  await assert.rejects(
    fetchSeaDexSnapshot({
      sourceBaseUrl: "https://releases.moe",
      pageSize: 100,
      retryLimit: 0,
      fetchImpl,
    }),
    /reported 2 entries but 1 rows were received/,
  );
});

test("SeaDex stability requires consecutive identical full snapshots", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return jsonResponse({
      page: 1,
      perPage: 100,
      totalItems: 1,
      totalPages: 1,
      items: [entry(1, [requestCount === 1 ? "old" : "new"])],
    });
  };

  const snapshot = await fetchStableSeaDexSnapshot({
    sourceBaseUrl: "https://releases.moe",
    pageSize: 100,
    requiredPasses: 2,
    retryLimit: 0,
    fetchImpl,
  });

  assert.equal(requestCount, 3);
  assert.equal(snapshot.entries[0].trs[0], "new");
});
