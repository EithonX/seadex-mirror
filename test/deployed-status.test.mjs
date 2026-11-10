import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertDeployedStatusMatches } from "../scripts/lib/deployed-status.mjs";

const manifest = { snapshotId: "current", sourceFingerprint: "source-2" };
const current = { snapshot: { id: "current", sourceFingerprint: "source-2" } };

test("deployment status verification accepts the current snapshot", () => {
  assert.doesNotThrow(() => assertDeployedStatusMatches(current, manifest, "current"));
});

test("deployment status rejects a stale alias and an incorrect source fingerprint", () => {
  const old = { snapshot: { id: "previous", sourceFingerprint: "source-1" } };
  assert.throws(() => assertDeployedStatusMatches(old, manifest, "current"), /expected snapshot/u);
  assert.throws(() => assertDeployedStatusMatches(old, manifest), /differs from manifest/u);
  assert.throws(
    () => assertDeployedStatusMatches({ snapshot: { id: "current", sourceFingerprint: "source-1" } }, manifest),
    /source fingerprint/u,
  );
});

test("production status identity is validated inside the retry callback", async () => {
  const verifier = await readFile(new URL("../scripts/verify-deployed-site.mjs", import.meta.url), "utf8");
  assert.match(
    verifier,
    /retryCheck\("\/mirror-data\/status\.json", async \(\) => \{[\s\S]*?assertDeployedStatusMatches\(value, manifestResult\.manifest, EXPECTED_SNAPSHOT_ID\)/u,
  );
});
