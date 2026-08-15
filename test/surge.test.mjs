import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SURGE_DOMAIN,
  SURGE_CLI_VERSION,
  normalizeSurgeDomain,
  surgeBaseUrl,
} from "../scripts/lib/surge.mjs";

test("Surge integration pins the expected CLI and default mirror domain", () => {
  assert.equal(SURGE_CLI_VERSION, "0.41.2");
  assert.equal(DEFAULT_SURGE_DOMAIN, "seadex.surge.sh");
  assert.equal(surgeBaseUrl(), "https://seadex.surge.sh");
});

test("Surge domain normalization accepts hostnames and simple HTTP(S) URLs", () => {
  assert.equal(normalizeSurgeDomain("SeaDex.Surge.sh"), "seadex.surge.sh");
  assert.equal(normalizeSurgeDomain("https://backup.example.org"), "backup.example.org");
  assert.equal(normalizeSurgeDomain("http://backup.example.org/"), "backup.example.org");
});

test("Surge domain normalization rejects unsafe or ambiguous targets", () => {
  for (const value of [
    "",
    "localhost",
    "https://example.org/path",
    "https://user@example.org",
    "https://example.org:8443",
    "ftp://example.org",
    "bad_host.example.org",
  ]) {
    assert.throws(() => normalizeSurgeDomain(value));
  }
});
