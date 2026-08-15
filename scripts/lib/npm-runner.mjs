import { spawn } from "node:child_process";
import process from "node:process";

export function resolveNpmInvocation(args, options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("npm arguments must be an array of strings.");
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const npmExecPath = typeof env.npm_execpath === "string" ? env.npm_execpath.trim() : "";

  if (npmExecPath) {
    return {
      command: execPath,
      args: [npmExecPath, ...args],
    };
  }

  if (platform === "win32") {
    throw new Error(
      "npm_execpath is unavailable on Windows. Run this command through `npm run deploy:bootstrap` " +
      "so npm can provide its JavaScript CLI path safely.",
    );
  }

  return {
    command: "npm",
    args,
  };
}

export function runNpm(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  const invocation = resolveNpmInvocation(args, {
    env,
    platform: options.platform,
    execPath: options.execPath,
  });
  const label = `npm ${args.join(" ")}`;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      stdio: options.stdio ?? "inherit",
    });

    child.once("error", (error) => {
      rejectPromise(new Error(`${label} could not start: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(new Error(`${label} failed with ${detail}.`));
    });
  });
}
