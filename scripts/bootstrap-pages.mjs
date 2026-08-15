// One-time production bootstrap from a locally generated, already verified snapshot.
// This intentionally does not fetch SeaDex or AniList. It publishes exactly the
// local mirror-data tree after verification, then verifies the production alias.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runNpm } from "./lib/npm-runner.mjs";
import { validateSnapshotManifest } from "./lib/snapshot-integrity.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_PROJECT_NAME = "seadex";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const projectName = normalizeProjectName(
    args.project ?? process.env.CLOUDFLARE_PAGES_PROJECT_NAME ?? DEFAULT_PROJECT_NAME,
  );

  console.log(`Bootstrapping Cloudflare Pages project ${projectName} from local verified mirror data.`);
  console.log("No SeaDex or AniList requests will be made by this command.");

  await runNpm(["run", "verify"], { cwd: PROJECT_ROOT });
  await runNpm(["run", "verify:mirror-data"], { cwd: PROJECT_ROOT });
  await runNpm(["run", "build:frontend"], { cwd: PROJECT_ROOT });
  await runNpm(["run", "verify:frontend-build"], { cwd: PROJECT_ROOT });
  await runNpm(["run", "verify:pages-limits"], { cwd: PROJECT_ROOT });

  const manifestPath = resolve(PROJECT_ROOT, "dist/mirror-data/manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateSnapshotManifest(manifest);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

  console.log(
    `Deploying snapshot ${manifest.snapshotId.slice(0, 12)} (${manifest.files.length} manifested files).`,
  );
  await runNpm([
    "exec",
    "--",
    "wrangler",
    "pages",
    "deploy",
    "dist",
    `--project-name=${projectName}`,
    "--branch=main",
    "--commit-dirty=true",
  ], { cwd: PROJECT_ROOT });

  console.log("Deployment uploaded. Verifying the production alias against the exact local manifest...");
  await runNpm(["run", "verify:deployed-site"], {
    cwd: PROJECT_ROOT,
    env: {
      CLOUDFLARE_PAGES_PROJECT_NAME: projectName,
      EXPECTED_SNAPSHOT_ID: manifest.snapshotId,
      EXPECTED_MANIFEST_SHA256: manifestSha256,
    },
  });

  console.log(
    `Bootstrap complete: production now serves verified snapshot ${manifest.snapshotId.slice(0, 12)}.`,
  );
}

function parseArgs(argv) {
  const result = { project: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg.startsWith("--project=")) {
      result.project = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--project") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--project requires a Cloudflare Pages project name.");
      }
      result.project = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function normalizeProjectName(value) {
  const name = String(value ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) {
    throw new Error(`Invalid Cloudflare Pages project name: ${name || "<empty>"}`);
  }
  return name;
}

function printHelp() {
  console.log(`Usage: npm run deploy:bootstrap -- [--project <name>]

Publishes the existing local frontend/public/mirror-data snapshot without
contacting SeaDex or AniList. The command runs the regression suite, verifies
mirror data, builds and verifies the frontend, checks Pages limits, deploys with
Wrangler, then verifies
the production alias against the exact local manifest.

Authentication:
  Run \`npx wrangler login\` first, or provide Cloudflare credentials supported
  by Wrangler in the environment.

Project name resolution:
  --project <name>
  CLOUDFLARE_PAGES_PROJECT_NAME
  seadex (default)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
