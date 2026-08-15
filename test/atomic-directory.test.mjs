import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replaceDirectoryAtomically } from "../scripts/lib/atomic-directory.mjs";

test("replaceDirectoryAtomically swaps a staged snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "seadex-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "mirror-data");
  const staged = join(root, ".mirror-data.tmp");
  await mkdir(target);
  await mkdir(staged);
  await writeFile(join(target, "value"), "old");
  await writeFile(join(staged, "value"), "new");

  await replaceDirectoryAtomically(staged, target);
  assert.equal(await readFile(join(target, "value"), "utf8"), "new");
});

test("replaceDirectoryAtomically rejects a non-directory staging path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "seadex-atomic-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "mirror-data");
  const staged = join(root, ".mirror-data.tmp");
  await mkdir(target);
  await writeFile(staged, "not a directory");

  await assert.rejects(replaceDirectoryAtomically(staged, target), /not a directory/u);
  assert.equal(await readFile(staged, "utf8"), "not a directory");
});
