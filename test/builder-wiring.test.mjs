import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BUILDER_PATH = new URL("../scripts/build-static-data.mjs", import.meta.url);
const EXPORTED_BINDING_PATTERN =
  /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;

const MODULES = [
  {
    label: "snapshot-integrity",
    path: new URL("../scripts/lib/snapshot-integrity.mjs", import.meta.url),
    specifier: "./lib/snapshot-integrity.mjs",
  },
  {
    label: "seadex-source",
    path: new URL("../scripts/lib/seadex-source.mjs", import.meta.url),
    specifier: "./lib/seadex-source.mjs",
  },
  {
    label: "tracker-links",
    path: new URL("../shared/tracker-links.mjs", import.meta.url),
    specifier: "../shared/tracker-links.mjs",
  },
];

for (const module of MODULES) {
  test(`static-data builder imports every ${module.label} binding it references`, async () => {
    const [builderSource, moduleSource] = await Promise.all([
      readFile(BUILDER_PATH, "utf8"),
      readFile(module.path, "utf8"),
    ]);

    const escapedSpecifier = module.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const importPattern = new RegExp(
      `import\\s*\\{(?<names>[^}]*)\\}\\s*from\\s*["']${escapedSpecifier}["'];`,
      "u",
    );
    const importMatch = builderSource.match(importPattern);
    assert.ok(importMatch?.groups?.names, `${module.label} import block is missing from the builder`);

    const importedNames = new Set(
      importMatch.groups.names
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(/\s+as\s+/u)[1] ?? part.split(/\s+as\s+/u)[0]),
    );

    const builderWithoutImport = builderSource.replace(importPattern, "");
    const exportedNames = [...moduleSource.matchAll(EXPORTED_BINDING_PATTERN)].map((match) => match[1]);
    const missingImports = exportedNames.filter((name) => {
      const referenced = new RegExp(`\\b${name}\\b`, "u").test(builderWithoutImport);
      return referenced && !importedNames.has(name);
    });

    assert.deepEqual(
      missingImports,
      [],
      `builder references ${module.label} exports without importing them: ${missingImports.join(", ")}`,
    );
  });
}
