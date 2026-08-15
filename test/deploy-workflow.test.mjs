import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/deploy-site.yml", import.meta.url), "utf8");

test("deploy workflow gates Cloudflare publication on site output changes", () => {
  assert.match(workflow, /Check whether production output changed/u);
  assert.match(workflow, /node scripts\/check-site-deployment\.mjs --report \.site-deploy-report\.json/u);
  assert.match(workflow, /Deploy Pages site\n\s+if: steps\.site-change\.outputs\.deploy == 'true'/u);
  assert.match(workflow, /Verify Cloudflare Pages access\n\s+if: steps\.site-change\.outputs\.deploy == 'true'/u);
  assert.match(workflow, /Skip unchanged deployment\n\s+if: steps\.site-change\.outputs\.deploy != 'true'/u);
});

test("test-only and rebuild-workflow-only changes do not trigger a site deployment workflow", () => {
  assert.doesNotMatch(workflow, /- "test\/\*\*"/u);
  assert.doesNotMatch(workflow, /- "\.github\/workflows\/rebuild-mirror\.yml"/u);
});
