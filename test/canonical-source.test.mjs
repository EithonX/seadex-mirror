import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repoFile(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("default SeaDex API source uses the upstream canonical domain", async () => {
  const [exampleEnv, builder, constants] = await Promise.all([
    repoFile(".env.example"),
    repoFile("scripts/build-static-data.mjs"),
    repoFile("frontend/src/constants.ts"),
  ]);

  assert.match(exampleEnv, /^SOURCE_BASE_URL=https:\/\/seadex\.moe$/mu);
  assert.match(builder, /const DEFAULT_SOURCE_BASE_URL = "https:\/\/seadex\.moe";/u);
  assert.match(constants, /UPSTREAM_SITE_URL = "https:\/\/seadex\.moe\/";/u);
  assert.match(constants, /UPSTREAM_ABOUT_URL = "https:\/\/seadex\.moe\/about\/";/u);
  assert.doesNotMatch(builder, /https:\/\/releases\.moe/u);
  assert.doesNotMatch(constants, /https:\/\/releases\.moe/u);
});

test("site attribution and descriptions name SeaDex's new domain", async () => {
  for (const path of [
    "README.md",
    "CONTRIBUTING.md",
    "frontend/src/main.ts",
    "frontend/index.html",
    "frontend/public/site.webmanifest",
  ]) {
    const source = await repoFile(path);
    assert.match(source, /seadex\.moe/u, `${path} must credit the current upstream`);
  }
});

test("legacy workbook and sheet embed remain supported separately from the canonical API", async () => {
  const [exampleEnv, constants, headers] = await Promise.all([
    repoFile(".env.example"),
    repoFile("frontend/src/constants.ts"),
    repoFile("frontend/public/_headers"),
  ]);
  assert.match(exampleEnv, /^SHEET_WORKBOOK_URL=https:\/\/docs\.google\.com\/spreadsheets\//mu);
  assert.match(constants, /UPSTREAM_SHEET_URL = "https:\/\/sheet\.releases\.moe\/";/u);
  assert.match(headers, /frame-src[^\n]+https:\/\/sheet\.releases\.moe/u);
});
