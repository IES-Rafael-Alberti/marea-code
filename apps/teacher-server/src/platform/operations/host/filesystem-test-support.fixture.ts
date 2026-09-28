import { expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const mockedFs = await import("node:fs/promises");
export const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
export const mkdir = mockedFs.mkdir;
export const lstatMock = mockedFs.lstat;
export const openMock = mockedFs.open;
export const rename = mockedFs.rename;
export const rm = mockedFs.rm;
export const writeFile = mockedFs.writeFile;

export async function createMockedLockFixture() {
  const root = await mockedFs.mkdtemp(join(tmpdir(), "marea-host-lock-"));
  return { root, lockPath: join(root, ".marea-installation.lock") };
}

export function createInitializationHandle(
  lockPath: string,
  write: (body: Uint8Array) => unknown,
  sync: () => unknown = () => Promise.resolve(),
) {
  return {
    writeFile: vi.fn(write),
    close: vi.fn(() => Promise.resolve()),
    stat: vi.fn(() => actualFs.lstat(lockPath)),
    sync: vi.fn(sync),
  };
}

export async function expectOwnershipChanged(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({
    code: "owner-busy",
    message: "installation lock ownership changed",
  });
}

export async function expectReplacementRecord(lockPath: string, marker: string) {
  await expect(actualFs.readFile(lockPath, "utf8")).resolves.toContain(marker);
  await rm(lockPath);
}
