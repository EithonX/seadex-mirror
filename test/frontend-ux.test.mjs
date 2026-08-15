import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalizeNewlines = (value) => value.replace(/\r\n?/gu, "\n");

test("private tracker actions use tracker-aware source resolution and stay clickable when resolvable", async () => {
  const source = normalizeNewlines(await readFile(new URL("../frontend/src/entry-page.ts", import.meta.url), "utf8"));

  assert.match(source, /resolveSeaDexTorrentActionUrl\(torrent, preferGrouped\)/u);
  assert.match(source, /const trackerIsPrivate = isSeaDexPrivateTracker\(torrent\.tracker\);/u);
  assert.match(source, /privateUrl: trackerIsPrivate \? resolvedUrl : null,/u);
  assert.match(source, /if \(links\.privateUrl\) \{[\s\S]*?href: links\.privateUrl,[\s\S]*?isPrivate: true,/u);
  assert.match(source, /const buttonClass = action\.isPrivate \? "torrent-button torrent-button--private-link" : "torrent-button";/u);
  assert.doesNotMatch(source, /isPrivateTrackerUrl/u);
});

test("mobile footer keeps statistics together and moves snapshot verification to its own row", async () => {
  const shell = normalizeNewlines(await readFile(new URL("../frontend/src/app-shell.ts", import.meta.url), "utf8"));
  const styles = normalizeNewlines(await readFile(new URL("../frontend/src/styles.css", import.meta.url), "utf8"));

  assert.match(shell, /<div class="site-footer__stats">[\s\S]*?<\/div>[\s\S]*?<div class="site-footer__verification">/u);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.site-footer__right \{[\s\S]*?flex-direction: column;/u);
  assert.match(styles, /\.site-footer__stats \{[\s\S]*?white-space: nowrap;/u);
  assert.match(styles, /\.site-footer__verification \.stat-sep \{\n\s+display: none;/u);
});

test("unlocking private tracker links preserves the two-column tracker action layout", async () => {
  const styles = normalizeNewlines(await readFile(new URL("../frontend/src/styles.css", import.meta.url), "utf8"));

  assert.match(
    styles,
    /\.torrent-card:has\(\.torrent-button--private, \.torrent-button--private-link\) \.torrent-card__actions \{\n\s+grid-template-columns: 1fr 1fr;/u,
  );
});
