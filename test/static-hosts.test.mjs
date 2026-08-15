import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("static host preparation creates an exact Surge SPA fallback and deterministic CNAME", async (t) => {
  const dist = await mkdtemp(join(tmpdir(), "seadex-static-hosts-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await writeFile(join(dist, "index.html"), "<!doctype html><main>SeaDex</main>\n", "utf8");

  const result = await runNode("scripts/prepare-static-hosts.mjs", {
    SITE_DIST_DIR: dist,
    SURGE_DOMAIN: "Backup.Example.org",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(dist, "200.html"), "utf8"), await readFile(join(dist, "index.html"), "utf8"));
  assert.equal(await readFile(join(dist, "CNAME"), "utf8"), "backup.example.org\n");
  const limits = await runNode("scripts/verify-surge-limits.mjs", {
    SITE_DIST_DIR: dist,
    SURGE_DOMAIN: "backup.example.org",
  });
  assert.equal(limits.code, 0, limits.stderr);
  assert.match(limits.stdout, /Surge preflight passed/u);
});

function runNode(script, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
