import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BUILDER_PATH = new URL("../scripts/build-static-data.mjs", import.meta.url);
const INTEGRITY_PATH = new URL("../scripts/lib/snapshot-integrity.mjs", import.meta.url);
const INTEGRITY_IMPORT_PATTERN =
  /import\s*{(?<names>[^}]*)}\s*from\s*["']\.\/lib\/snapshot-integrity\.mjs["'];/;
const EXPORTED_BINDING_PATTERN =
  /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;

test("static-data builder imports every snapshot-integrity binding it references", async () => {
  const [builderSource, integritySource] = await Promise.all([
    readFile(BUILDER_PATH, "utf8"),
    readFile(INTEGRITY_PATH, "utf8"),
  ]);

  const importMatch = builderSource.match(INTEGRITY_IMPORT_PATTERN);
  assert.ok(importMatch?.groups?.names, "snapshot-integrity import block is missing from the builder");

  const importedNames = new Set(
    importMatch.groups.names
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+as\s+/u)[1] ?? part.split(/\s+as\s+/u)[0]),
  );

  const builderWithoutImport = builderSource.replace(INTEGRITY_IMPORT_PATTERN, "");
  const exportedNames = [...integritySource.matchAll(EXPORTED_BINDING_PATTERN)].map((match) => match[1]);
  const missingImports = exportedNames.filter((name) => {
    const referenced = new RegExp(`\\b${name}\\b`, "u").test(builderWithoutImport);
    return referenced && !importedNames.has(name);
  });

  assert.deepEqual(
    missingImports,
    [],
    `builder references snapshot-integrity exports without importing them: ${missingImports.join(", ")}`,
  );
});
