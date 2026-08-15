import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readWorkflow(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return source.replace(/\r\n?/gu, "\n");
}

const deployWorkflow = await readWorkflow("../.github/workflows/deploy-site.yml");
const rebuildWorkflow = await readWorkflow("../.github/workflows/rebuild-mirror.yml");

for (const [name, workflow] of [["deploy", deployWorkflow], ["rebuild", rebuildWorkflow]]) {
  test(`${name} workflow pins Surge CLI and deploys the verified dist tree independently`, () => {
    assert.match(workflow, /SURGE_CLI_VERSION: "0\.41\.2"/u);
    assert.match(workflow, /SURGE_DOMAIN: \$\{\{ vars\.SURGE_DOMAIN \|\| 'seadex\.surge\.sh' \}\}/u);
    assert.match(workflow, /npm exec --yes --package="surge@\$\{SURGE_CLI_VERSION\}" -- surge \.\/dist "https:\/\/\$\{SURGE_DOMAIN\}"/u);
    assert.match(workflow, /SURGE_TOKEN: \$\{\{ secrets\.SURGE_TOKEN \}\}/u);
    assert.match(workflow, /Verify Surge mirror/u);
    assert.match(workflow, /EXPECTED_SITE_FINGERPRINT/u);
  });
}

test("deploy workflow gates Cloudflare and Surge publication independently", () => {
  assert.match(deployWorkflow, /Check whether Cloudflare output changed/u);
  assert.match(deployWorkflow, /Check whether Surge output changed/u);
  assert.match(deployWorkflow, /id: cloudflare-change/u);
  assert.match(deployWorkflow, /id: surge-change/u);
  assert.match(deployWorkflow, /- name: Deploy Pages site\n\s+if: steps\.cloudflare-change\.outputs\.deploy == 'true'/u);
  assert.match(deployWorkflow, /- name: Deploy Surge mirror\n\s+if: .*steps\.surge-change\.outputs\.deploy == 'true'/u);
  assert.match(deployWorkflow, /Skip unchanged Cloudflare deployment/u);
  assert.match(deployWorkflow, /Skip unchanged Surge deployment/u);
});

test("scheduled rebuild checks and repairs the secondary mirror even when source data is unchanged", () => {
  assert.match(rebuildWorkflow, /Check secondary mirror health/u);
  assert.match(rebuildWorkflow, /node scripts\/check-site-peer\.mjs --report \.surge-health-report\.json/u);
  assert.match(rebuildWorkflow, /Restore verified production snapshot for mirror repair/u);
  assert.match(rebuildWorkflow, /steps\.surge-health\.outputs\.repair == 'true'/u);
});

test("test-only and rebuild-workflow-only changes do not trigger a site deployment workflow", () => {
  assert.doesNotMatch(deployWorkflow, /- "test\/\*\*"/u);
  assert.doesNotMatch(deployWorkflow, /- "\.github\/workflows\/rebuild-mirror\.yml"/u);
});
