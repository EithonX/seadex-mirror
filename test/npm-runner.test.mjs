import assert from "node:assert/strict";
import test from "node:test";
import { resolveNpmInvocation } from "../scripts/lib/npm-runner.mjs";

test("resolveNpmInvocation runs npm's JavaScript CLI through Node when npm_execpath is available", () => {
  const invocation = resolveNpmInvocation(["run", "verify"], {
    env: { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.deepEqual(invocation, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: [
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "run",
      "verify",
    ],
  });
});

test("resolveNpmInvocation rejects Windows fallback that would require spawning npm.cmd", () => {
  assert.throws(
    () => resolveNpmInvocation(["run", "verify"], {
      env: {},
      platform: "win32",
      execPath: "C:\\node\\node.exe",
    }),
    /npm_execpath is unavailable on Windows/u,
  );
});

test("resolveNpmInvocation falls back to npm directly on POSIX", () => {
  assert.deepEqual(
    resolveNpmInvocation(["run", "verify"], {
      env: {},
      platform: "linux",
      execPath: "/usr/bin/node",
    }),
    { command: "npm", args: ["run", "verify"] },
  );
});

test("resolveNpmInvocation rejects non-string arguments", () => {
  assert.throws(
    () => resolveNpmInvocation(["run", 123], {
      env: { npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" },
      platform: "linux",
      execPath: "/usr/bin/node",
    }),
    /array of strings/u,
  );
});
