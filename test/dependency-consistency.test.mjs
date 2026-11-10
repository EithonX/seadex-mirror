import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest, lockfile and explicitly approved install scripts are in sync", async () => {
  const [manifest, lock] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `lock version for ${name}`);
  }

  const expectedAllowed = Object.fromEntries(
    ["esbuild", "workerd"].map((name) => {
      const version = lock.packages[`node_modules/${name}`]?.version;
      assert.ok(version, `${name} must be present in the npm lockfile`);
      return [`${name}@${version}`, true];
    }),
  );
  assert.deepEqual(manifest.allowScripts, expectedAllowed);
});
