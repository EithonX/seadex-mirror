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
  const entries = [entry(1, "torrent-1"), entry(2, "torrent-2")];
  const workbookBuffer = await buildWorkbookBuffer();
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
      response.end("1,2");
      return;
    }

    if (url.pathname === "/api/collections/entries/records") {
      if (url.searchParams.get("perPage") === "1") {
        counters.entryRevision += 1;
        writeJson(response, {
          page: 1,
          perPage: 1,
          totalItems: 2,
          totalPages: 2,
          items: [{ id: "entry-2", updated: FIXED_TIME }],
        });
        return;
      }

      counters.fullEntryPages += 1;
      writeJson(response, {
        page: 1,
        perPage: Number(url.searchParams.get("perPage") ?? 500),
        totalItems: entries.length,
        totalPages: 1,
        items: entries,
      });
      return;
    }

    if (url.pathname === "/api/collections/torrents/records") {
      counters.torrentRevision += 1;
      writeJson(response, {
        page: 1,
        perPage: 1,
        totalItems: 2,
        totalPages: 2,
        items: [{ id: "torrent-2", updated: FIXED_TIME }],
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
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}

function writeJson(response, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(200, {
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
