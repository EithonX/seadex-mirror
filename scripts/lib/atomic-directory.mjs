import { access, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function replaceDirectoryAtomically(stagedDir, targetDir, options = {}) {
  const staged = resolve(stagedDir);
  const target = resolve(targetDir);
  const targetParent = dirname(target);
  const stagedParent = dirname(staged);

  if (staged === target) {
    throw new Error("Staged and target directories must be different.");
  }
  if (stagedParent !== targetParent) {
    throw new Error("Atomic directory replacement requires staging beside the target on the same filesystem.");
  }
  if (!(await pathExists(staged))) {
    throw new Error(`Staged directory does not exist: ${staged}`);
  }
  if (!(await stat(staged)).isDirectory()) {
    throw new Error(`Staged path is not a directory: ${staged}`);
  }
  if ((await pathExists(target)) && !(await stat(target)).isDirectory()) {
    throw new Error(`Target path exists but is not a directory: ${target}`);
  }

  const backupDir = join(
    targetParent,
    `.${basename(target)}.bak-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let backupCreated = false;

  try {
    if (await pathExists(target)) {
      await rename(target, backupDir);
      backupCreated = true;
    }

    await rename(staged, target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});

    if (!(await pathExists(target)) && backupCreated && (await pathExists(backupDir))) {
      try {
        await rename(backupDir, target);
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new AggregateError(
          [error, restoreError],
          `Directory replacement failed and the previous snapshot could not be restored: ${message}`,
        );
      }
    }

    throw error;
  }

  // Cleanup happens only after the new target is fully installed. A stale backup is
  // harmless and should never make an otherwise successful atomic replacement fail.
  if (backupCreated) {
    await rm(backupDir, { recursive: true, force: true }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[atomic-directory] Installed ${target}, but could not remove ${backupDir}: ${message}`);
    });
  }
}

export async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
