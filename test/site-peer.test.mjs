import assert from "node:assert/strict";
import test from "node:test";
import { compareSiteIdentities } from "../scripts/check-site-peer.mjs";

const fingerprint = "a".repeat(64);
const snapshotId = "b".repeat(64);
const manifest = "c".repeat(64);

function identity(baseUrl, overrides = {}) {
  return {
    baseUrl,
    descriptor: {
      fingerprint,
      snapshotId,
      mirrorManifestSha256: manifest,
    },
    manifestSha256: manifest,
    error: null,
    ...overrides,
  };
}

test("secondary site health accepts identical primary and secondary identities", () => {
  const result = compareSiteIdentities(identity("https://primary.test"), identity("https://secondary.test"));
  assert.equal(result.repair, false);
  assert.equal(result.reason, "sites-in-sync");
});

test("secondary site health requests repair when the secondary is unavailable", () => {
  const result = compareSiteIdentities(identity("https://primary.test"), {
    baseUrl: "https://secondary.test",
    descriptor: null,
    manifestSha256: null,
    error: "404",
  });
  assert.equal(result.repair, true);
  assert.equal(result.reason, "secondary-site-unavailable");
});

test("secondary site health detects fingerprint, snapshot, and manifest divergence", () => {
  const primary = identity("https://primary.test");

  assert.equal(compareSiteIdentities(primary, identity("https://secondary.test", {
    descriptor: { fingerprint: "d".repeat(64), snapshotId, mirrorManifestSha256: manifest },
  })).reason, "site-fingerprint-mismatch");

  assert.equal(compareSiteIdentities(primary, identity("https://secondary.test", {
    descriptor: { fingerprint, snapshotId: "e".repeat(64), mirrorManifestSha256: manifest },
  })).reason, "snapshot-mismatch");

  assert.equal(compareSiteIdentities(primary, identity("https://secondary.test", {
    manifestSha256: "f".repeat(64),
  })).reason, "mirror-manifest-mismatch");
});
