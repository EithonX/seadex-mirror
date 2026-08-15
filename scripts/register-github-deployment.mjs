import { parseArgs } from "node:util";
import { ensureStableGitHubDeployment } from "./lib/github-deployment.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/register-github-deployment.mjs --environment <name> --url <https-url> --description <text> --snapshot <sha256> --fingerprint <sha256>",
    "",
    "Ensures GitHub has a stable successful deployment record for an already verified production host.",
    "Requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA.",
  ].join("\n");
}

const { values } = parseArgs({
  options: {
    environment: { type: "string" },
    url: { type: "string" },
    description: { type: "string" },
    snapshot: { type: "string" },
    fingerprint: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
  strict: true,
});

if (values.help) {
  console.log(usage());
  process.exit(0);
}

const repository = process.env.GITHUB_REPOSITORY;
const ref = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN;
const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const runId = process.env.GITHUB_RUN_ID;
const logUrl = repository && runId
  ? `${serverUrl.replace(/\/+$/u, "")}/${repository}/actions/runs/${runId}`
  : undefined;

try {
  const result = await ensureStableGitHubDeployment({
    token,
    repository,
    ref,
    environment: values.environment,
    environmentUrl: values.url,
    description: values.description,
    snapshotId: values.snapshot,
    siteFingerprint: values.fingerprint,
    logUrl,
    apiUrl,
  });

  if (result.created) {
    console.log(
      `Registered GitHub deployment ${result.deploymentId}: ${result.environment} → ${result.environmentUrl}`,
    );
  } else {
    console.log(
      `GitHub deployment already current: ${result.environment} → ${result.environmentUrl}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
