import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeploymentPayload,
  buildDeploymentStatusPayload,
  ensureStableGitHubDeployment,
  normalizeDeploymentUrl,
} from "../scripts/lib/github-deployment.mjs";

const SNAPSHOT = "1".repeat(64);
const FINGERPRINT = "2".repeat(64);

test("stable GitHub deployment uses a production environment, stable URL, and content identity", () => {
  assert.deepEqual(
    buildDeploymentPayload({
      ref: "a".repeat(40),
      environment: "Cloudflare Primary",
      environmentUrl: "https://seadex.pages.dev/",
      description: "Verified Cloudflare primary mirror",
      snapshotId: SNAPSHOT,
      siteFingerprint: FINGERPRINT,
    }),
    {
      ref: "a".repeat(40),
      task: "deploy",
      auto_merge: false,
      required_contexts: [],
      environment: "Cloudflare Primary",
      description: "Verified Cloudflare primary mirror",
      transient_environment: false,
      production_environment: true,
      payload: {
        marker: "seadex-mirror-stable-v1",
        environmentUrl: "https://seadex.pages.dev",
        snapshotId: SNAPSHOT,
        siteFingerprint: FINGERPRINT,
      },
    },
  );

  assert.deepEqual(
    buildDeploymentStatusPayload({
      environment: "Cloudflare Primary",
      environmentUrl: "https://seadex.pages.dev/",
      description: "Verified Cloudflare primary mirror",
      logUrl: "https://github.com/EithonX/seadex-mirror/actions/runs/123",
    }),
    {
      state: "success",
      environment: "Cloudflare Primary",
      environment_url: "https://seadex.pages.dev",
      description: "Verified Cloudflare primary mirror",
      auto_inactive: false,
      log_url: "https://github.com/EithonX/seadex-mirror/actions/runs/123",
    },
  );
});

test("deployment URL validation rejects non-HTTPS and ambiguous URLs", () => {
  assert.equal(normalizeDeploymentUrl("https://seadex.surge.sh/"), "https://seadex.surge.sh");
  assert.throws(() => normalizeDeploymentUrl("http://seadex.surge.sh"), /HTTPS/u);
  assert.throws(() => normalizeDeploymentUrl("https://user@example.com"), /credentials/u);
  assert.throws(() => normalizeDeploymentUrl("https://example.com/?x=1"), /query string/u);
});

test("ensureStableGitHubDeployment creates deployment then success status when marker is absent", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ id: 42 }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 99, state: "success" }), { status: 201 });
  };

  const result = await ensureStableGitHubDeployment({
    fetchImpl,
    token: "test-token",
    repository: "EithonX/seadex-mirror",
    ref: "b".repeat(40),
    environment: "Surge Backup",
    environmentUrl: "https://seadex.surge.sh",
    description: "Verified Surge backup mirror",
    snapshotId: SNAPSHOT,
    siteFingerprint: FINGERPRINT,
    logUrl: "https://github.com/EithonX/seadex-mirror/actions/runs/456",
  });

  assert.deepEqual(result, {
    created: true,
    deploymentId: 42,
    environment: "Surge Backup",
    environmentUrl: "https://seadex.surge.sh",
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /deployments\?environment=Surge\+Backup&per_page=20$/u);
  assert.equal(calls[1].url, "https://api.github.com/repos/EithonX/seadex-mirror/deployments");
  assert.equal(calls[2].url, "https://api.github.com/repos/EithonX/seadex-mirror/deployments/42/statuses");
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(calls[1].options.headers["X-GitHub-Api-Version"], "2026-03-10");

  const createBody = JSON.parse(calls[1].options.body);
  const statusBody = JSON.parse(calls[2].options.body);
  assert.equal(createBody.production_environment, true);
  assert.deepEqual(createBody.required_contexts, []);
  assert.equal(createBody.payload.siteFingerprint, FINGERPRINT);
  assert.equal(statusBody.environment_url, "https://seadex.surge.sh");
  assert.equal(statusBody.auto_inactive, false);
});

test("ensureStableGitHubDeployment is idempotent for an already successful matching marker", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response(JSON.stringify([{
        id: 77,
        payload: {
          marker: "seadex-mirror-stable-v1",
          environmentUrl: "https://seadex.pages.dev",
          snapshotId: SNAPSHOT,
          siteFingerprint: FINGERPRINT,
        },
      }]), { status: 200 });
    }
    return new Response(JSON.stringify([{
      state: "success",
      environment_url: "https://seadex.pages.dev",
    }]), { status: 200 });
  };

  const result = await ensureStableGitHubDeployment({
    fetchImpl,
    token: "test-token",
    repository: "EithonX/seadex-mirror",
    ref: "c".repeat(40),
    environment: "Cloudflare Primary",
    environmentUrl: "https://seadex.pages.dev",
    description: "Verified Cloudflare primary mirror",
    snapshotId: SNAPSHOT,
    siteFingerprint: FINGERPRINT,
  });

  assert.deepEqual(result, {
    created: false,
    deploymentId: 77,
    environment: "Cloudflare Primary",
    environmentUrl: "https://seadex.pages.dev",
  });
  assert.equal(calls.length, 2, "no create/status POST should occur for the same successful content identity");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "GET");
});

test("ensureStableGitHubDeployment does not trust a matching deployment without a successful stable status", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response(JSON.stringify([{
        id: 88,
        payload: {
          marker: "seadex-mirror-stable-v1",
          environmentUrl: "https://seadex.surge.sh",
          snapshotId: SNAPSHOT,
          siteFingerprint: FINGERPRINT,
        },
      }]), { status: 200 });
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify([{ state: "failure", environment_url: "https://seadex.surge.sh" }]), { status: 200 });
    }
    if (calls.length === 3) {
      return new Response(JSON.stringify({ id: 89 }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 100, state: "success" }), { status: 201 });
  };

  const result = await ensureStableGitHubDeployment({
    fetchImpl,
    token: "test-token",
    repository: "EithonX/seadex-mirror",
    ref: "d".repeat(40),
    environment: "Surge Backup",
    environmentUrl: "https://seadex.surge.sh",
    description: "Verified Surge backup mirror",
    snapshotId: SNAPSHOT,
    siteFingerprint: FINGERPRINT,
  });

  assert.equal(result.created, true);
  assert.equal(result.deploymentId, 89);
  assert.equal(calls.length, 4);
});
