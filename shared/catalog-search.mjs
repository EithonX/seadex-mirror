const MAX_QUERY_CHARS = 192;
const MAX_QUERY_TOKENS = 16;
const MAX_FUZZY_TOKEN_CHARS = 64;

const LATIN_COMBINING_MARKS = /[\u0300-\u036f]/gu;
const APOSTROPHES = /['’ʻʼ`´]/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;
const WHITESPACE = /\s+/gu;
const DIGITS = /^\d+$/u;
const ALPHANUMERIC = /^[\p{L}\p{N}]+$/u;

const ORDINAL_WORDS = new Map([
  ["first", "1"],
  ["second", "2"],
  ["third", "3"],
  ["fourth", "4"],
  ["fifth", "5"],
  ["sixth", "6"],
  ["seventh", "7"],
  ["eighth", "8"],
  ["ninth", "9"],
  ["tenth", "10"],
  ["eleventh", "11"],
  ["twelfth", "12"],
]);

const documentCache = new WeakMap();
const supplementalDocumentCache = new WeakMap();

/**
 * Search-only normalization. It deliberately does not mutate the mirrored data.
 * Punctuation and Latin diacritics become non-semantic while letters/numbers in
 * every script are retained.
 */
export function normalizeCatalogSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(LATIN_COMBINING_MARKS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/&/gu, " and ")
    .replace(/[×✕]/gu, " x ")
    .replace(/\+/gu, " plus ")
    .replace(NON_ALPHANUMERIC, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

export function compileCatalogSearchQuery(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const normalized = normalizeCatalogSearchText(raw.slice(0, MAX_QUERY_CHARS));
  if (!normalized) {
    return null;
  }

  const tokens = unique(normalized.split(" ").filter(Boolean)).slice(0, MAX_QUERY_TOKENS);
  const significantTokens = tokens.filter(isSignificantQueryToken);

  return Object.freeze({
    normalized,
    compact: compact(normalized),
    tokens: Object.freeze(tokens),
    significantTokens: Object.freeze(significantTokens.length > 0 ? significantTokens : tokens),
    numericId: DIGITS.test(normalized) ? normalized : null,
  });
}

/**
 * Return a relevance score, or null when the item should not match the query.
 * The score is intentionally internal: callers should only compare scores from
 * the same query.
 */
export function scoreCatalogSearchItem(item, query) {
  if (!item || !query) {
    return null;
  }

  const document = getSearchDocument(item);
  const alId = String(item.alId ?? "");
  if (query.numericId && query.numericId === alId) {
    return 12_000;
  }

  let bestTitleScore = 0;
  for (const title of document.titles) {
    bestTitleScore = Math.max(bestTitleScore, scoreTitleVariant(title, query));
  }
  if (bestTitleScore > 0) {
    return bestTitleScore;
  }

  const titleTokenQuality = scoreAllTokens(query.significantTokens, document.titleField, true);
  if (titleTokenQuality !== null) {
    return 7_000 + titleTokenQuality * 900;
  }

  const supplemental = getSupplementalSearchDocument(item);
  let bestGroupScore = 0;
  for (const group of supplemental.groups) {
    if (group.normalized === query.normalized) {
      bestGroupScore = Math.max(bestGroupScore, 5_200);
    } else if (group.normalized.includes(query.normalized) && query.normalized.length >= 3) {
      bestGroupScore = Math.max(bestGroupScore, 4_850);
    }
  }

  // Preserve the old notes/ID substring capability, but rank it below title and
  // release-group matches.
  const blobContainsQuery = supplemental.searchBlob.includes(query.normalized);
  const tokenScore = scoreQueryTokens(document, supplemental, query);
  if (!tokenScore) {
    return bestGroupScore || (blobContainsQuery ? 3_300 : null);
  }

  const { averageQuality, titleHits, groupHits, metadataHits, searchHits } = tokenScore;
  let score;
  if (titleHits === query.significantTokens.length) {
    score = 7_000 + averageQuality * 900;
  } else if (titleHits > 0) {
    score = 6_100 + averageQuality * 800 + titleHits * 60 + metadataHits * 25;
  } else if (groupHits > 0) {
    score = 4_300 + averageQuality * 650 + groupHits * 40;
  } else if (metadataHits > 0) {
    score = 3_700 + averageQuality * 500;
  } else if (searchHits > 0) {
    score = 2_800 + averageQuality * 450;
  } else {
    return bestGroupScore || (blobContainsQuery ? 3_300 : null);
  }

  if (blobContainsQuery) {
    score += 90;
  }
  return Math.max(score, bestGroupScore);
}

function getSearchDocument(item) {
  const cached = documentCache.get(item);
  if (cached) {
    return cached;
  }

  const titleValues = unique([
    item.titles?.english,
    item.titles?.userPreferred,
    item.titles?.display,
  ].map(normalizeCatalogSearchText).filter(Boolean));
  const titles = titleValues.map(buildVariant);
  const document = Object.freeze({
    titles: Object.freeze(titles),
    titleField: buildTokenField(unique(titles.flatMap((value) => value.tokens))),
  });
  documentCache.set(item, document);
  return document;
}

function getSupplementalSearchDocument(item) {
  const cached = supplementalDocumentCache.get(item);
  if (cached) {
    return cached;
  }

  const groups = unique([
    ...(Array.isArray(item.bestGroups) ? item.bestGroups : []),
    ...(Array.isArray(item.altGroups) ? item.altGroups : []),
  ].map(normalizeCatalogSearchText).filter(Boolean)).map(buildVariant);
  const searchBlob = normalizeCatalogSearchText(item.searchText ?? item.excerpt ?? "");
  const metadataTokens = unique([
    item.alId,
    item.startYear,
    item.seasonYear,
    item.format,
    item.season,
    item.status,
    item.episodes == null ? null : String(item.episodes),
  ].map(normalizeCatalogSearchText).filter(Boolean).flatMap((value) => value.split(" ")));

  const supplemental = Object.freeze({
    groups: Object.freeze(groups),
    groupField: buildTokenField(unique(groups.flatMap((value) => value.tokens))),
    metadataField: buildTokenField(metadataTokens),
    searchField: buildTokenField(unique(searchBlob.split(" ").filter(Boolean))),
    searchBlob,
  });
  supplementalDocumentCache.set(item, supplemental);
  return supplemental;
}

function buildVariant(normalized) {
  const tokens = normalized.split(" ").filter(Boolean);
  return Object.freeze({
    normalized,
    compact: compact(normalized),
    tokens: Object.freeze(tokens),
    acronyms: Object.freeze(buildAcronyms(tokens)),
  });
}

function buildTokenField(tokens) {
  const frozenTokens = Object.freeze(tokens);
  return Object.freeze({
    tokens: frozenTokens,
    tokenSet: new Set(frozenTokens),
    canonicalSet: new Set(frozenTokens.map(canonicalToken)),
  });
}

function scoreTitleVariant(title, query) {
  if (title.normalized === query.normalized) {
    return 10_000;
  }
  if (query.compact.length >= 3 && title.compact === query.compact) {
    return 9_800;
  }
  if (title.normalized.startsWith(query.normalized)) {
    return 9_100 - Math.min(250, title.normalized.length - query.normalized.length);
  }
  const phraseIndex = title.normalized.indexOf(query.normalized);
  if (phraseIndex >= 0) {
    return 8_650 - Math.min(300, phraseIndex * 3);
  }
  if (query.compact.length >= 4) {
    const compactIndex = title.compact.indexOf(query.compact);
    if (compactIndex >= 0) {
      return 8_300 - Math.min(300, compactIndex * 2);
    }
  }
  if (
    query.tokens.length === 1 &&
    query.normalized.length >= 2 &&
    query.normalized.length <= 8 &&
    ALPHANUMERIC.test(query.normalized) &&
    title.acronyms.includes(query.normalized)
  ) {
    return 8_050;
  }

  if (query.compact.length >= 5 && title.compact.length >= 5) {
    const allowed = allowedEditDistance(query.compact);
    if (allowed > 0 && Math.abs(query.compact.length - title.compact.length) <= allowed) {
      const distance = boundedDamerauLevenshtein(query.compact, title.compact, allowed);
      if (distance <= allowed) {
        return 7_900 - distance * 120;
      }
    }
  }
  return 0;
}

function scoreAllTokens(queryTokens, field, fuzzy) {
  if (queryTokens.length === 0) {
    return null;
  }
  let total = 0;
  for (const queryToken of queryTokens) {
    const quality = bestTokenQuality(queryToken, field, fuzzy);
    if (quality <= 0) {
      return null;
    }
    total += quality;
  }
  return total / queryTokens.length;
}

function scoreQueryTokens(document, supplemental, query) {
  const queryTokens = query.significantTokens;
  if (queryTokens.length === 0) {
    return null;
  }

  let totalQuality = 0;
  let titleHits = 0;
  let groupHits = 0;
  let metadataHits = 0;
  let searchHits = 0;

  for (const queryToken of queryTokens) {
    const titleQuality = bestTokenQuality(queryToken, document.titleField, true);
    const groupQuality = bestTokenQuality(queryToken, supplemental.groupField, true) * 0.9;
    const metadataQuality = bestTokenQuality(queryToken, supplemental.metadataField, false) * 0.94;
    const searchQuality = bestTokenQuality(queryToken, supplemental.searchField, false) * 0.72;
    const best = Math.max(titleQuality, groupQuality, metadataQuality, searchQuality);

    if (best <= 0) {
      return null;
    }
    totalQuality += best;
    if (titleQuality === best) {
      titleHits += 1;
    } else if (groupQuality === best) {
      groupHits += 1;
    } else if (metadataQuality === best) {
      metadataHits += 1;
    } else {
      searchHits += 1;
    }
  }

  return {
    averageQuality: totalQuality / queryTokens.length,
    titleHits,
    groupHits,
    metadataHits,
    searchHits,
  };
}

function bestTokenQuality(queryToken, field, fuzzy) {
  const canonicalQuery = canonicalToken(queryToken);
  if (field.tokenSet.has(queryToken) || field.canonicalSet.has(canonicalQuery)) {
    return 1;
  }

  let best = 0;
  for (const candidate of field.tokens) {
    const quality = tokenQuality(queryToken, candidate, fuzzy, false);
    if (quality > best) {
      best = quality;
    }
  }
  return best;
}

function tokenQuality(queryToken, candidateToken, fuzzy, checkExact = true) {
  if (checkExact && (queryToken === candidateToken || canonicalToken(queryToken) === canonicalToken(candidateToken))) {
    return 1;
  }
  if (queryToken.length >= 3 && candidateToken.startsWith(queryToken)) {
    return 0.94;
  }
  if (queryToken.length >= 4 && candidateToken.includes(queryToken)) {
    return 0.86;
  }
  if (!fuzzy || queryToken.length < 4 || queryToken.length > MAX_FUZZY_TOKEN_CHARS) {
    return 0;
  }

  const allowed = allowedEditDistance(queryToken);
  if (allowed === 0 || Math.abs(queryToken.length - candidateToken.length) > allowed) {
    return 0;
  }
  const distance = boundedDamerauLevenshtein(queryToken, candidateToken, allowed);
  if (distance > allowed) {
    return 0;
  }
  return Math.max(0.64, 1 - distance / Math.max(queryToken.length, candidateToken.length));
}

function allowedEditDistance(token) {
  const length = token.length;
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  if (length <= 12) return 2;
  return 3;
}

/** Optimal-string-alignment distance with an upper bound and adjacent swaps. */
function boundedDamerauLevenshtein(left, right, maxDistance) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previousPrevious = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array(right.length + 1);
    current[0] = row;
    let rowMinimum = current[0];

    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost,
      );
      if (
        previousPrevious &&
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        value = Math.min(value, previousPrevious[column - 2] + 1);
      }
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function buildAcronyms(tokens) {
  if (tokens.length < 2) {
    return [];
  }
  const all = tokens.map((token) => token[0] ?? "").join("");
  const substantial = tokens.filter((token) => token.length > 2).map((token) => token[0] ?? "").join("");
  return unique([all, substantial].filter((value) => value.length >= 2));
}

function canonicalToken(token) {
  const numericOrdinal = /^(\d+)(?:st|nd|rd|th)$/u.exec(token);
  if (numericOrdinal) {
    return String(Number(numericOrdinal[1]));
  }
  const seasonNumber = /^s(\d{1,2})$/u.exec(token);
  if (seasonNumber) {
    return String(Number(seasonNumber[1]));
  }
  return ORDINAL_WORDS.get(token) ?? token;
}

function isSignificantQueryToken(token) {
  return token.length >= 3 || /\d/u.test(token);
}

function compact(value) {
  return value.replace(/ /gu, "");
}

function unique(values) {
  return [...new Set(values)];
}
