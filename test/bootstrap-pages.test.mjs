import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("bootstrap deploy command has a side-effect-free help path", async () => {
  const result = await runNode(["scripts/bootstrap-pages.mjs", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /without\s+contacting SeaDex or AniList/u);
  assert.match(result.stdout, /production alias against the exact local manifest/u);
  assert.equal(result.stderr, "");
});

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
