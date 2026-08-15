// One-time Surge bootstrap from the existing local verified snapshot.
// This does not fetch SeaDex or AniList; it publishes the exact built dist tree.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runNpm } from "./lib/npm-runner.mjs";
import { validateSnapshotManifest } from "./lib/snapshot-integrity.mjs";
import { readSiteBuildDescriptor } from "./lib/site-build.mjs";
import { DEFAULT_SURGE_DOMAIN, SURGE_CLI_VERSION, normalizeSurgeDomain, surgeBaseUrl } from "./lib/surge.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const domain = normalizeSurgeDomain(args.domain ?? process.env.SURGE_DOMAIN ?? DEFAULT_SURGE_DOMAIN);
  const baseUrl = surgeBaseUrl(domain);

  console.log(`Bootstrapping Surge mirror ${baseUrl} from local verified mirror data.`);
  console.log("No SeaDex or AniList requests will be made by this command.");

  const commonEnv = { SURGE_DOMAIN: domain };
  await runNpm(["run", "verify"], { cwd: PROJECT_ROOT, env: commonEnv });
  await runNpm(["run", "verify:mirror-data"], { cwd: PROJECT_ROOT, env: commonEnv });
  await runNpm(["run", "build:frontend"], { cwd: PROJECT_ROOT, env: commonEnv });
  await runNpm(["run", "verify:frontend-build"], { cwd: PROJECT_ROOT, env: commonEnv });
  await runNpm(["run", "verify:surge-limits"], { cwd: PROJECT_ROOT, env: commonEnv });

  const manifestBytes = await readFile(resolve(PROJECT_ROOT, "dist/mirror-data/manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateSnapshotManifest(manifest);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const siteBuild = await readSiteBuildDescriptor(resolve(PROJECT_ROOT, "dist/site-build.json"));

  console.log(`Publishing site ${siteBuild.fingerprint.slice(0, 12)} to ${baseUrl} with Surge ${SURGE_CLI_VERSION}.`);
  await runNpm([
    "exec",
    "--yes",
    `--package=surge@${SURGE_CLI_VERSION}`,
    "--",
    "surge",
    "./dist",
    baseUrl,
    "--message",
    `snapshot ${manifest.snapshotId.slice(0, 12)}`,
  ], { cwd: PROJECT_ROOT, env: commonEnv });

  console.log("Surge publish completed. Verifying the live domain against the exact local identity...");
  await runNpm(["run", "verify:deployed-site"], {
    cwd: PROJECT_ROOT,
    env: {
      ...commonEnv,
      DEPLOYED_SITE_URL: baseUrl,
      EXPECTED_SNAPSHOT_ID: manifest.snapshotId,
      EXPECTED_MANIFEST_SHA256: manifestSha256,
      EXPECTED_SITE_FINGERPRINT: siteBuild.fingerprint,
    },
  });

  console.log(`Surge bootstrap complete: ${baseUrl} serves verified snapshot ${manifest.snapshotId.slice(0, 12)}.`);
}

function parseArgs(argv) {
  const result = { domain: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg.startsWith("--domain=")) {
      result.domain = arg.slice("--domain=".length);
      continue;
    }
    if (arg === "--domain") {
      const next = argv[index + 1];
      if (!next || next.startsWith("-")) throw new Error("--domain requires a Surge hostname.");
      result.domain = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printHelp() {
  console.log(`Usage: npm run deploy:surge-bootstrap -- [--domain <hostname>]

Publishes the existing local verified mirror snapshot to Surge without contacting
SeaDex or AniList. It runs tests, verifies mirror data, builds the frontend,
checks Surge limits, publishes the exact dist tree, then verifies the live site.

Authentication:
  Run \`npm exec --yes --package=surge@${SURGE_CLI_VERSION} -- surge login\` first,
  or provide SURGE_TOKEN in the environment.

Domain resolution:
  --domain <hostname>
  SURGE_DOMAIN
  ${DEFAULT_SURGE_DOMAIN} (default)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
