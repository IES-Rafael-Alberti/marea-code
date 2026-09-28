import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./manifest.js";

export interface SourceFile {
  readonly path: string;
  readonly sha256: string | null;
}

/** Build and inventory the same new dependency tree; never reuse a developer's package store. */
export function withBuildWorkspace<T>(
  source: string,
  files: readonly SourceFile[],
  operation: (workspace: string) => T,
): T {
  const workspace = mkdtempSync(join(tmpdir(), "marea-build-"));
  try {
    for (const file of files) {
      const destination = resolve(workspace, file.path);
      const path = relative(workspace, destination);
      if (isAbsolute(file.path) || path === ".." || path.startsWith(`..${sep}`))
        throw new Error("Source snapshot escapes build workspace");
      if (file.sha256 === null) continue;
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, file.path), destination);
      if (sha256(readFileSync(destination)) !== file.sha256)
        throw new Error("Source changed while copying build workspace");
    }
    return operation(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
