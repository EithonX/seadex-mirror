import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viteConfigUrl = new URL("../vite.config.mjs", import.meta.url);

test("Vite keeps the workbook manual chunk explicit so it remains lazy", async () => {
  const source = await readFile(viteConfigUrl, "utf8");

  assert.match(
    source,
    /onlyExplicitManualChunks\s*:\s*true/,
    "manual sheet chunking must not absorb shared dependencies",
  );
  assert.match(
    source,
    /endsWith\(\s*["']\/frontend\/src\/sheet-workbook\.ts["']\s*\)/,
    "sheet-workbook.ts should remain the only explicitly named workbook manual chunk",
  );
});
