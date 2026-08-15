const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_API_URL = "https://api.github.com";
const STABLE_DEPLOYMENT_MARKER = "seadex-mirror-stable-v1";

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireSha256(value, label) {
  const sha = requireNonEmptyString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(sha)) {
    throw new Error(`${label} must be a 64-character SHA-256 hex digest.`);
  }
  return sha;
}

export function normalizeGitHubRepository(value) {
  const repository = requireNonEmptyString(value, "GitHub repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    throw new Error(`GitHub repository must use owner/name form; received ${JSON.stringify(repository)}.`);
  }
  return repository;
}

export function normalizeDeploymentEnvironment(value) {
  const environment = requireNonEmptyString(value, "Deployment environment");
  if (environment.length > 255) {
    throw new Error("Deployment environment must be 255 characters or fewer.");
  }
  return environment;
}

export function normalizeDeploymentUrl(value) {
  const input = requireNonEmptyString(value, "Deployment URL");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Deployment URL is invalid: ${JSON.stringify(input)}.`);
  }
  if (url.protocol !== "https:") {
    throw new Error("Deployment URL must use HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Deployment URL must not contain credentials, a query string, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export function buildDeploymentPayload({
  ref,
  environment,
  environmentUrl,
  description,
  snapshotId,
  siteFingerprint,
}) {
  const normalizedUrl = normalizeDeploymentUrl(environmentUrl);
  return {
    ref: requireNonEmptyString(ref, "GitHub ref"),
    task: "deploy",
    auto_merge: false,
    required_contexts: [],
    environment: normalizeDeploymentEnvironment(environment),
    description: requireNonEmptyString(description, "Deployment description"),
    transient_environment: false,
    production_environment: true,
    payload: {
      marker: STABLE_DEPLOYMENT_MARKER,
      environmentUrl: normalizedUrl,
      snapshotId: requireSha256(snapshotId, "Snapshot id"),
      siteFingerprint: requireSha256(siteFingerprint, "Site fingerprint"),
    },
  };
}

export function buildDeploymentStatusPayload({ environment, environmentUrl, description, logUrl }) {
  const statusDescription = requireNonEmptyString(description, "Deployment status description");
  if (statusDescription.length > 140) {
    throw new Error("Deployment status description must be 140 characters or fewer.");
  }

  const payload = {
    state: "success",
    environment: normalizeDeploymentEnvironment(environment),
    environment_url: normalizeDeploymentUrl(environmentUrl),
    description: statusDescription,
    auto_inactive: false,
  };

  if (typeof logUrl === "string" && logUrl.trim() !== "") {
    payload.log_url = normalizeDeploymentUrl(logUrl);
  }

  return payload;
}

async function requestGitHubJson(fetchImpl, url, { token, method = "GET", body }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let json = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GitHub API ${method} ${url} returned invalid JSON (HTTP ${response.status}).`);
    }
  }

  if (!response.ok) {
    const apiMessage = typeof json?.message === "string" ? `: ${json.message}` : "";
    throw new Error(`GitHub API ${method} ${url} failed with HTTP ${response.status}${apiMessage}`);
  }

  return json;
}

function deploymentMatchesIdentity(deployment, expectedPayload) {
  const payload = deployment?.payload;
  return payload
    && typeof payload === "object"
    && payload.marker === STABLE_DEPLOYMENT_MARKER
    && payload.environmentUrl === expectedPayload.environmentUrl
    && payload.snapshotId === expectedPayload.snapshotId
    && payload.siteFingerprint === expectedPayload.siteFingerprint;
}

async function findExistingStableDeployment({
  fetchImpl,
  apiBase,
  token,
  repository,
  environment,
  expectedPayload,
}) {
  const query = new URLSearchParams({ environment, per_page: "20" });
  const deployments = await requestGitHubJson(
    fetchImpl,
    `${apiBase}/repos/${repository}/deployments?${query}`,
    { token },
  );

  if (!Array.isArray(deployments)) {
    throw new Error("GitHub deployments response was not an array.");
  }

  for (const deployment of deployments) {
    if (!deploymentMatchesIdentity(deployment, expectedPayload)) {
      continue;
    }

    const deploymentId = Number(deployment?.id);
    if (!Number.isSafeInteger(deploymentId) || deploymentId <= 0) {
      continue;
    }

    const statuses = await requestGitHubJson(
      fetchImpl,
      `${apiBase}/repos/${repository}/deployments/${deploymentId}/statuses?per_page=1`,
      { token },
    );
    const latest = Array.isArray(statuses) ? statuses[0] : null;
    if (
      latest?.state === "success"
      && latest.environment_url === expectedPayload.environmentUrl
    ) {
      return deploymentId;
    }
  }

  return null;
}

export async function ensureStableGitHubDeployment({
  fetchImpl = globalThis.fetch,
  token,
  repository,
  ref,
  environment,
  environmentUrl,
  description,
  snapshotId,
  siteFingerprint,
  logUrl,
  apiUrl = DEFAULT_API_URL,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const authToken = requireNonEmptyString(token, "GITHUB_TOKEN");
  const repo = normalizeGitHubRepository(repository);
  const apiBase = normalizeDeploymentUrl(apiUrl);
  const deploymentPayload = buildDeploymentPayload({
    ref,
    environment,
    environmentUrl,
    description,
    snapshotId,
    siteFingerprint,
  });

  const existingDeploymentId = await findExistingStableDeployment({
    fetchImpl,
    apiBase,
    token: authToken,
    repository: repo,
    environment: deploymentPayload.environment,
    expectedPayload: deploymentPayload.payload,
  });
  if (existingDeploymentId !== null) {
    return {
      created: false,
      deploymentId: existingDeploymentId,
      environment: deploymentPayload.environment,
      environmentUrl: deploymentPayload.payload.environmentUrl,
    };
  }

  const deployment = await requestGitHubJson(
    fetchImpl,
    `${apiBase}/repos/${repo}/deployments`,
    { token: authToken, method: "POST", body: deploymentPayload },
  );

  const deploymentId = Number(deployment?.id);
  if (!Number.isSafeInteger(deploymentId) || deploymentId <= 0) {
    throw new Error("GitHub deployment response did not contain a valid deployment id.");
  }

  const statusPayload = buildDeploymentStatusPayload({
    environment,
    environmentUrl,
    description,
    logUrl,
  });

  await requestGitHubJson(
    fetchImpl,
    `${apiBase}/repos/${repo}/deployments/${deploymentId}/statuses`,
    { token: authToken, method: "POST", body: statusPayload },
  );

  return {
    created: true,
    deploymentId,
    environment: deploymentPayload.environment,
    environmentUrl: statusPayload.environment_url,
  };
}
