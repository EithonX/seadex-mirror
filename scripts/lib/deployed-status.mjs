export function assertDeployedStatusMatches(status, manifest, expectedSnapshotId = "") {
  const snapshotId = status?.snapshot?.id;
  if (expectedSnapshotId && snapshotId !== expectedSnapshotId) {
    throw new Error("status.json snapshot ID differs from expected snapshot");
  }
  if (snapshotId !== manifest.snapshotId) {
    throw new Error("status.json snapshot ID differs from manifest");
  }
  if (status?.snapshot?.sourceFingerprint !== manifest.sourceFingerprint) {
    throw new Error("status.json source fingerprint differs from manifest");
  }
}
