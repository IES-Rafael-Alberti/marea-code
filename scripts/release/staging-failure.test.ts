import { mkdtempSync as makeRoot, realpathSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ failStage: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if (mocks.failStage) throw new Error("No staging space");
      return fs.mkdtempSync(...args);
    },
  };
});
import { installRelease, privateDirectory } from "./install.boundary.js";
it("releases the installer lock when staging cannot be created", async () => {
  const root = realpathSync(makeRoot(join(tmpdir(), "release-no-space-")));
  try {
    mocks.failStage = true;
    await expect(
      installRelease(
        {
          root,
          source: root,
          component: "student",
          version: "1.2.3",
          repository: "o/r",
          ref: "refs/heads/main",
        },
        {
          privateDirectory,
          verifySignature: vi.fn(),
          withOfflineBackup: (operation) => operation(),
        },
      ),
    ).rejects.toThrow("No staging space");
    expect(existsSync(join(root, ".release.lock"))).toBe(false);
  } finally {
    mocks.failStage = false;
    rmSync(root, { recursive: true, force: true });
  }
});
