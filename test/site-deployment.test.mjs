import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDeployment } from "../scripts/check-site-deployment.mjs";
import { createSiteBuildDescriptor, descriptorIdentity } from "../scripts/lib/site-build.mjs";
import { createSnapshotManifest, sha256Json } from "../scripts/lib/snapshot-integrity.mjs";

const SNAPSHOT_ID = "c".repeat(64);
const SOURCE_FINGERPRINT = "d".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "seadex-site-deploy-"));
  const mirrorDir = join(root, "mirror-data");
  await mkdir(mirrorDir, { recursive: true });
  await writeFile(join(root, "index.html"), "<main>SeaDex</main>\n", "utf8");
  await writeFile(join(mirrorDir, "status.json"), '{"ok":true}\n', "utf8");
  const manifest = await createSnapshotManifest(mirrorDir, {
    snapshotId: SNAPSHOT_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    generatedAt: "2026-08-16T00:00:00.000Z",
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(mirrorDir, "manifest.json"), manifestBytes);
  const descriptor = await createSiteBuildDescriptor(root);
  return { root, descriptor, manifestBytes };
}

function fakeFetch({ descriptor, manifestBytes, siteStatus = 200, manifestStatus = 200 }) {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/site-build.json")) {
      return new Response(siteStatus === 200 ? JSON.stringify(descriptor) : "missing", {
        status: siteStatus,
        headers: { "content-type": siteStatus === 200 ? "application/json" : "text/plain" },
      });
    }
    if (url.endsWith("/mirror-data/manifest.json")) {
      return new Response(manifestStatus === 200 ? manifestBytes : "missing", {
        status: manifestStatus,
        headers: { "content-type": manifestStatus === 200 ? "application/json" : "text/plain" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("deployment check skips when production identity and mirror manifest match", async (t) => {
  const { root, descriptor, manifestBytes } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkDeployment({
    baseUrl: "https://example.test",
    local: descriptor,
    retries: 0,
    fetchImpl: fakeFetch({ descriptor, manifestBytes }),
  });

  assert.equal(result.deploy, false);
  assert.equal(result.reason, "site-output-unchanged");
});

test("deployment check deploys when site fingerprint changes", async (t) => {
  const { root, descriptor, manifestBytes } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = structuredClone(descriptor);
  remote.files[0].sha256 = "e".repeat(64);
  remote.fingerprint = sha256Json(descriptorIdentity(remote));

  const result = await checkDeployment({
    baseUrl: "https://example.test",
    local: descriptor,
    retries: 0,
    fetchImpl: fakeFetch({ descriptor: remote, manifestBytes }),
  });

  assert.equal(result.deploy, true);
  assert.equal(result.reason, "site-fingerprint-changed");
});

test("deployment check fails open to deployment when production metadata is unavailable", async (t) => {
  const { root, descriptor, manifestBytes } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkDeployment({
    baseUrl: "https://example.test",
    local: descriptor,
    retries: 0,
    fetchImpl: fakeFetch({ descriptor, manifestBytes, siteStatus: 404 }),
  });

  assert.equal(result.deploy, true);
  assert.equal(result.reason, "production-site-build-unavailable");
});

test("deployment check deploys when production mirror manifest differs", async (t) => {
  const { root, descriptor } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await checkDeployment({
    baseUrl: "https://example.test",
    local: descriptor,
    retries: 0,
    fetchImpl: fakeFetch({ descriptor, manifestBytes: Buffer.from('{"different":true}\n') }),
  });

  assert.equal(result.deploy, true);
  assert.equal(result.reason, "production-manifest-mismatch");
});
