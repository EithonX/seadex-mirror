import { resolve } from "node:path";
import { writeSiteBuildDescriptor } from "./lib/site-build.mjs";

const distDir = resolve(process.env.PAGES_DIST_DIR ?? "dist");

async function main() {
  const descriptor = await writeSiteBuildDescriptor(distDir);
  console.log(
    `Site build stamped: ${descriptor.fingerprint.slice(0, 12)} (${descriptor.files.length} frontend/static files, snapshot ${descriptor.snapshotId.slice(0, 12)}).`,
  );
}

main().catch((error) => {
  console.error(`Site build stamping failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
