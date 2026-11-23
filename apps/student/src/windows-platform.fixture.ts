import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

/** Restores the real platform, mocks and temporary roots after each Windows-simulating test. */
export function useWindowsPlatformSandbox(prefix: string): () => Promise<string> {
  const platform = process.platform;
  const roots: string[] = [];
  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  return async () => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
}
