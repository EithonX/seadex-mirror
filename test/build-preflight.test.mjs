import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ExcelJS from "exceljs";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXED_TIME = "2026-08-15 00:00:00.000Z";

function torrent(id) {
  return {
    id,
    releaseGroup: `Group-${id}`,
    tracker: "Nyaa",
    url: `https://example.test/${id}`,
    groupedUrl: "",
    infoHash: `hash-${id}`,
    dualAudio: false,
    isBest: true,
    tags: [],
    files: [],
    updated: FIXED_TIME,
  };
}

function entry(alID, torrentId) {
  const expandedTorrent = torrent(torrentId);
  return {
    id: `entry-${alID}`,
    alID,
    comparison: "",
    notes: "",
    theoreticalBest: null,
    incomplete: false,
    trs: [torrentId],
    expand: { trs: [expandedTorrent] },
    created: FIXED_TIME,
    updated: FIXED_TIME,
  };
}

function aniListMedia(id) {
  return {
    id,
    title: { userPreferred: `Anime ${id}`, english: null },
    coverImage: { extraLarge: null, color: null },
    season: null,
    seasonYear: 2026,
    startDate: { year: 2026 },
    format: "TV",
    status: "FINISHED",
    episodes: 1,
    duration: 24,
    averageScore: 80,
    genres: [],
    relations: { edges: [] },
  };
}

async function buildWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Main");
  sheet.getCell("A1").value = "SeaDex mirror test";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function startFixtureServer() {
  const workbookBuffer = await buildWorkbookBuffer();
  const state = {
    aniListForbidden: false,
    entries: [entry(1, "torrent-1"), entry(2, "torrent-2")],
  };
  const counters = {
    listIds: 0,
    entryRevision: 0,
    torrentRevision: 0,
    fullEntryPages: 0,
    workbook: 0,
    aniList: 0,
  };

  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url ?? "/", origin);

    if (url.pathname === "/api/listIDs") {
      counters.listIds += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(state.entries.map((item) => item.alID).join(","));
      return;
    }

    if (url.pathname === "/api/collections/entries/records") {
      if (url.searchParams.get("perPage") === "1") {
        counters.entryRevision += 1;
        writeJson(response, {
          page: 1,
          perPage: 1,
          totalItems: state.entries.length,
          totalPages: state.entries.length,
          items: [{ id: state.entries.at(-1).id, updated: state.entries.at(-1).updated }],
        });
        return;
      }

      counters.fullEntryPages += 1;
      writeJson(response, {
        page: 1,
        perPage: Number(url.searchParams.get("perPage") ?? 500),
        totalItems: state.entries.length,
        totalPages: 1,
        items: state.entries,
      });
      return;
    }

    if (url.pathname === "/api/collections/torrents/records") {
      counters.torrentRevision += 1;
      writeJson(response, {
        page: 1,
        perPage: 1,
        totalItems: state.entries.length,
        totalPages: state.entries.length,
        items: [{ id: state.entries.at(-1).trs[0], updated: state.entries.at(-1).expand.trs[0].updated }],
      });
      return;
    }

    if (url.pathname === "/sheet.xlsx") {
      counters.workbook += 1;
      response.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-length": String(workbookBuffer.length),
      });
      response.end(workbookBuffer);
      return;
    }

    if (url.pathname === "/graphql" && request.method === "POST") {
      counters.aniList += 1;
      if (state.aniListForbidden) {
        writeJson(response, {
          errors: [{ message: "The AniList API has been temporarily disabled for this network.", status: 403 }],
          data: null,
        }, 403);
        return;
      }
      const body = JSON.parse(await readRequestBody(request));
      const ids = Array.isArray(body?.variables?.ids) ? body.variables.ids : [];
      writeJson(response, {
        data: {
          Page: {
            pageInfo: { total: ids.length },
            media: ids.map((id) => aniListMedia(id)),
          },
        },
      });
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`Unexpected fixture request: ${url.pathname}${url.search}`);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    counters,
    resetCounters() {
      for (const key of Object.keys(counters)) counters[key] = 0;
    },
    setAniListForbidden(value) {
      state.aniListForbidden = Boolean(value);
    },
    addEntry(alID) {
      state.entries.push(entry(alID, `torrent-${alID}`));
    },
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}

function writeJson(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function runBuilder(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["scripts/build-static-data.mjs", ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ANILIST_ACCESS_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`builder exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

test("unchanged build confirms lightweight guards and skips the full SeaDex crawl", async (t) => {
  const fixture = await startFixtureServer();
  const outputDir = await mkdtemp(join(tmpdir(), "seadex-preflight-build-"));
  t.after(async () => {
    await fixture.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  const args = [
    `--source=${fixture.baseUrl}`,
    `--anilist=${fixture.baseUrl}/graphql`,
    `--sheetWorkbookUrl=${fixture.baseUrl}/sheet.xlsx`,
    `--out=${outputDir}`,
    "--delayMs=0",
    "--retryLimit=0",
    "--sourceCaptureAttempts=2",
  ];

  const first = await runBuilder(args);
  assert.match(first.stdout, /"action": "rebuilt"/u);
  assert.ok(fixture.counters.fullEntryPages > 0, "first build must perform a full SeaDex crawl");
  assert.equal(fixture.counters.aniList, 1);

  fixture.resetCounters();
  const second = await runBuilder(args);
  assert.match(second.stdout, /skipping the full SeaDex record crawl/u);
  assert.match(second.stdout, /"action": "skipped"/u);
  assert.match(second.stdout, /"sourceCheck": "confirmed-lightweight-guard"/u);
  assert.equal(fixture.counters.fullEntryPages, 0, "unchanged fast path must not fetch expanded entry pages");
  assert.equal(fixture.counters.listIds, 2, "unchanged fast path must confirm the listIDs guard twice");
  assert.equal(fixture.counters.entryRevision, 2, "unchanged fast path must confirm entry revision twice");
  assert.equal(fixture.counters.torrentRevision, 2, "unchanged fast path must confirm torrent revision twice");
  assert.equal(fixture.counters.workbook, 1, "workbook content still participates in change detection");
  assert.equal(fixture.counters.aniList, 0, "fresh AniList cache must not be refreshed on an unchanged skip");
});


test("fresh build fails closed when AniList is unavailable and no previous cache exists", async (t) => {
  const fixture = await startFixtureServer();
  const outputDir = await mkdtemp(join(tmpdir(), "seadex-no-cache-anilist-failure-"));
  fixture.setAniListForbidden(true);
  t.after(async () => {
    await fixture.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  await assert.rejects(
    runBuilder([
      `--source=${fixture.baseUrl}`,
      `--anilist=${fixture.baseUrl}/graphql`,
      `--sheetWorkbookUrl=${fixture.baseUrl}/sheet.xlsx`,
      `--out=${outputDir}`,
      "--batchSize=1",
      "--delayMs=0",
      "--retryLimit=0",
      "--sourceCaptureAttempts=2",
    ]),
    /refusing to publish an incomplete snapshot/u,
  );
  assert.equal(fixture.counters.aniList, 1, "terminal 403 must stop after the first AniList request");
});


test("source growth fails closed when AniList cannot resolve the newly added entry", async (t) => {
  const fixture = await startFixtureServer();
  const outputDir = await mkdtemp(join(tmpdir(), "seadex-new-entry-anilist-failure-"));
  t.after(async () => {
    await fixture.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  const commonArgs = [
    `--source=${fixture.baseUrl}`,
    `--anilist=${fixture.baseUrl}/graphql`,
    `--sheetWorkbookUrl=${fixture.baseUrl}/sheet.xlsx`,
    `--out=${outputDir}`,
    "--batchSize=1",
    "--delayMs=0",
    "--retryLimit=0",
    "--sourceCaptureAttempts=2",
  ];

  await runBuilder(commonArgs);
  fixture.addEntry(3);
  fixture.setAniListForbidden(true);
  fixture.resetCounters();

  await assert.rejects(
    runBuilder(commonArgs),
    /resolved 2\/3 active entry record\(s\).*refusing to publish an incomplete snapshot/u,
  );
  assert.ok(fixture.counters.fullEntryPages > 0, "a changed source must still perform the full SeaDex crawl");
  assert.equal(fixture.counters.aniList, 1, "terminal AniList 403 must stop after the first unresolved batch");
});
