import { existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
import { privateDirectory } from "./install.boundary.js";

/** Publish a complete first installation at once; interrupted work never occupies its final path. */
export async function installPreviewAtomically(
  root: string,
  prepare: (stage: string) => Promise<void>,
): Promise<void> {
  const parent = dirname(root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Use the same filesystem so promotion is one atomic directory rename.
  const stage = mkdtempSync(join(parent, `.${basename(root)}-install-`));
  try {
    securePrivatePath(stage, 0o700);
    privateDirectory(stage);
    await prepare(stage);
    if (existsSync(root)) {
      privateDirectory(root);
      // Only an empty root accepted before preparation can be removed. A new or concurrent
      // installation is nonempty, so rmdir refuses it without changing any of its contents.
      rmdirSync(root);
    }
    renameSync(stage, root);
  } finally {
    // A killed process may leave this scratch directory, but retrying uses another one.
    // Never remove the final root: after promotion it is already a usable installation.
    rmSync(stage, { recursive: true, force: true });
  }
}
