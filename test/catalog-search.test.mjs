import assert from "node:assert/strict";
import test from "node:test";
import {
  compileCatalogSearchQuery,
  normalizeCatalogSearchText,
  scoreCatalogSearchItem,
} from "../shared/catalog-search.mjs";

function item({
  alId,
  english,
  userPreferred = english,
  display = english,
  bestGroups = [],
  altGroups = [],
  year = 2024,
  format = "TV",
  excerpt = null,
  searchText,
}) {
  return {
    alId,
    titles: { english, userPreferred, display },
    bestGroups,
    altGroups,
    startYear: year,
    seasonYear: year,
    format,
    season: "SPRING",
    status: "FINISHED",
    episodes: 12,
    excerpt,
    searchText: searchText ?? [english, userPreferred, excerpt, alId].filter(Boolean).join(" ").toLowerCase(),
  };
}

function score(value, query) {
  return scoreCatalogSearchItem(value, compileCatalogSearchQuery(query));
}

test("normalization tolerates punctuation, Latin diacritics, and joined title forms", () => {
  assert.equal(normalizeCatalogSearchText("Pokémon: Horizons"), "pokemon horizons");
  assert.equal(normalizeCatalogSearchText("Steins;Gate"), "steins gate");
  assert.ok(score(item({ alId: 1, english: "Pokémon: Horizons" }), "pokemon horizons"));
  assert.ok(score(item({ alId: 2, english: "Steins;Gate" }), "steinsgate"));
  assert.ok(score(item({ alId: 3, english: "Re:Zero − Starting Life in Another World" }), "rezero"));
});

test("title matching tolerates realistic spelling mistakes and adjacent transpositions", () => {
  const demonSlayer = item({ alId: 10, english: "Demon Slayer: Kimetsu no Yaiba" });
  const frieren = item({ alId: 11, english: "Frieren: Beyond Journey's End" });
  const onePiece = item({ alId: 12, english: "One Piece" });
  assert.ok(score(demonSlayer, "demon slayre"));
  assert.ok(score(frieren, "freiren"));
  assert.ok(score(onePiece, "one peice"));
});

test("title token order is not significant", () => {
  const attack = item({ alId: 20, english: "Attack on Titan" });
  assert.ok(score(attack, "titan attack"));
  assert.ok(score(attack, "attack titan"));
});

test("English and userPreferred titles are first-class aliases", () => {
  const attack = item({
    alId: 21,
    english: "Attack on Titan",
    userPreferred: "Shingeki no Kyojin",
  });
  assert.ok(score(attack, "attack on titan"));
  assert.ok(score(attack, "shingeki kyojin"));
});

test("common title acronyms can match without enabling arbitrary short-token fuzziness", () => {
  const attack = item({ alId: 30, english: "Attack on Titan" });
  assert.ok(score(attack, "aot"));

  const unrelated = item({ alId: 31, english: "Blue Lock" });
  assert.equal(score(unrelated, "aot"), null);
  assert.equal(score(unrelated, "bt"), null);
});

test("year, format, and release group can refine a title query", () => {
  const show = item({
    alId: 40,
    english: "Example Show Second Season",
    year: 2023,
    format: "TV",
    bestGroups: ["SeaDexGroup"],
  });
  assert.ok(score(show, "example show 2023"));
  assert.ok(score(show, "example tv"));
  assert.ok(score(show, "seadexgroup"));
});

test("ordinal and compact season notation are comparable", () => {
  const show = item({ alId: 41, english: "Example Show 2nd Season" });
  assert.ok(score(show, "example show season 2"));
  assert.ok(score(show, "example show s2"));
});

test("exact AniList ID wins decisively", () => {
  const exact = item({ alId: 16498, english: "Attack on Titan" });
  const incidental = item({ alId: 99, english: "16498 Stories" });
  const query = compileCatalogSearchQuery("16498");
  assert.ok(scoreCatalogSearchItem(exact, query) > scoreCatalogSearchItem(incidental, query));
});

test("title matches outrank incidental notes and release-group matches", () => {
  const title = item({ alId: 50, english: "Frieren" });
  const note = item({ alId: 51, english: "Different Show", excerpt: "Frieren comparison notes" });
  const group = item({ alId: 52, english: "Another Show", bestGroups: ["Frieren"] });
  const query = compileCatalogSearchQuery("frieren");
  const titleScore = scoreCatalogSearchItem(title, query);
  assert.ok(titleScore > scoreCatalogSearchItem(group, query));
  assert.ok(titleScore > scoreCatalogSearchItem(note, query));
});

test("a typo does not turn into broad fuzzy noise in unrelated short tokens", () => {
  const candidate = item({ alId: 60, english: "A Silent Voice" });
  assert.equal(score(candidate, "an"), null);
  assert.equal(score(candidate, "zz"), null);
});

test("pathological query length is bounded and deterministic", () => {
  const query = compileCatalogSearchQuery("a".repeat(10_000));
  assert.ok(query.normalized.length <= 192);
  assert.ok(query.tokens.length <= 16);
  assert.equal(scoreCatalogSearchItem(item({ alId: 70, english: "Normal Title" }), query), null);
});
