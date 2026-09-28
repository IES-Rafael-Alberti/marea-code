import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, type ReleaseManifest } from "./manifest.js";

/** Enumerates only ordinary files: archives, symlinks and hardlinks are never followed. */
export function ordinaryFiles(root: string): string[] {
  if (realpathSync(root) !== resolve(root) || !lstatSync(root).isDirectory())
    throw new Error("Noncanonical release directory");
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw new Error("Symlink in release");
      if (status.isDirectory()) walk(path, `${relative}/`);
      else if (status.isFile() && status.nlink === 1) files.push(relative);
      else throw new Error("Nonregular release entry");
    }
  };
  walk(root, "");
  return files.sort();
}
export function verifyFiles(root: string, manifest: ReleaseManifest): void {
  const expected = manifest.files.map((file) => file.path).sort();
  const actual = ordinaryFiles(root).filter(
    (path) => !["manifest.json", "manifest.sigstore.json"].includes(path),
  );
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Release file inventory mismatch");
  for (const file of manifest.files) {
    if (sha256(readFileSync(join(root, file.path))) !== file.sha256)
      throw new Error("Release checksum mismatch");
  }
}
