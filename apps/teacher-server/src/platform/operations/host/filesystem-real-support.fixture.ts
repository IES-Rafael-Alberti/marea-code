import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

export async function createRealLockFixture() {
  const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
  return { root, path: join(root, ".marea-installation.lock") };
}

export async function expectOwnershipChanged(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({
    code: "owner-busy",
    message: "installation lock ownership changed",
  });
}

export async function replaceLockRecord(
  path: string,
  field: "token" | "canonicalRoot",
  root: string,
) {
  const original = await readFile(path);
  const changed = JSON.parse(original.toString()) as Record<string, unknown>;
  changed[field] = field === "token" ? "different-token" : `${root}-different`;
  await writeFile(path, JSON.stringify(changed));
  return original;
}

export function transientInspectPath(message: string, code: string) {
  let acquired = false;
  let injected = false;
  const inspectPath = async (candidate: string) => {
    if (acquired && !injected) {
      injected = true;
      throw Object.assign(new Error(message), { code });
    }
    return lstat(candidate);
  };
  return { inspectPath, markAcquired: () => (acquired = true) };
}

export function lockHandle(lock: unknown) {
  return (
    lock as {
      handle: {
        read: (buffer: Buffer) => Promise<{ bytesRead: number; buffer: Buffer }>;
        close: () => Promise<void>;
      };
    }
  ).handle;
}
