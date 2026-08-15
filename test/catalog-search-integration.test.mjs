import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalizeNewlines = (value) => value.replace(/\r\n?/gu, "\n");

test("catalog filtering is wired to scored search instead of raw substring matching", async () => {
  const source = normalizeNewlines(await readFile(new URL("../shared/mirror.ts", import.meta.url), "utf8"));
  assert.match(source, /import \{ compileCatalogSearchQuery, scoreCatalogSearchItem \} from "\.\/catalog-search\.mjs";/u);
  assert.match(source, /const compiledSearch = compileCatalogSearchQuery\(search\);/u);
  assert.match(source, /const score = scoreCatalogSearchItem\(item, compiledSearch\);/u);
  assert.doesNotMatch(source, /searchText\.includes\(lowerSearch\)/u);
});

test("search relevance buckets precede the selected view sort", async () => {
  const source = normalizeNewlines(await readFile(new URL("../shared/mirror.ts", import.meta.url), "utf8"));
  assert.match(source, /Math\.floor\(right\.score \/ 500\) - Math\.floor\(left\.score \/ 500\)/u);
  assert.match(source, /compareCatalogItems\(left\.item, right\.item, sort, order\)/u);
});
