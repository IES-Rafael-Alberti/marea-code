import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceError, type WorkspaceLimits } from "./contracts.js";
import { openGuardedWorkspace } from "./guarded-workspace.js";

describe("guarded workspace initialization", () => {
  let containerPath: string;
  let rootPath: string;

  beforeEach(async () => {
    containerPath = await mkdtemp(join(tmpdir(), "marea-workspace-root-"));
    rootPath = join(containerPath, "project");
    await mkdir(rootPath);
  });

  afterEach(async () => {
    await chmod(rootPath, 0o700).catch(() => undefined);
    await rm(containerPath, { force: true, recursive: true });
  });

  it("opens a directory and canonicalizes a symlinked ancestor", async ({ skip }) => {
    const actualParent = join(containerPath, "actual");
    const linkedParent = join(containerPath, "linked");
    await mkdir(actualParent);
    await mkdir(join(actualParent, "child"));
    try {
      await symlink(actualParent, linkedParent, "dir");
    } catch {
      skip("Symbolic links are unavailable on this platform.");
    }

    const workspace = await openGuardedWorkspace({ rootPath: join(linkedParent, "child") });

    await expect(workspace.list("/")).resolves.toEqual([]);
  });

  it.each(["", "   ", "bad\0root"])("rejects invalid root text %j", async (invalidRoot) => {
    await expect(openGuardedWorkspace({ rootPath: invalidRoot })).rejects.toEqual(
      new WorkspaceError("invalid-root", "initialize"),
    );
  });

  it("rejects missing and regular-file roots", async () => {
    const filePath = join(containerPath, "file");
    await writeFile(filePath, "content");

    await expect(
      openGuardedWorkspace({ rootPath: join(containerPath, "missing") }),
    ).rejects.toEqual(new WorkspaceError("invalid-root", "initialize"));
    await expect(openGuardedWorkspace({ rootPath: filePath })).rejects.toEqual(
      new WorkspaceError("invalid-root", "initialize"),
    );
  });

  it("rejects a symbolic-link root when links are supported", async ({ skip }) => {
    const linkPath = join(containerPath, "link");
    try {
      await symlink(rootPath, linkPath, "dir");
    } catch {
      skip("Symbolic links are unavailable on this platform.");
    }

    await expect(openGuardedWorkspace({ rootPath: linkPath })).rejects.toEqual(
      new WorkspaceError("invalid-root", "initialize"),
    );
  });

  it.each([
    ["maxReadBytes", 0],
    ["maxReadBytes", 1.5],
    ["maxReadBytes", 134_217_729],
    ["maxWriteBytes", 0],
    ["maxWriteBytes", 134_217_729],
    ["maxDirectoryEntries", 0],
    ["maxDirectoryEntries", 100_001],
  ] satisfies readonly (readonly [keyof WorkspaceLimits, number])[])(
    "rejects %s limit %d",
    async (name, value) => {
      await expect(openGuardedWorkspace({ rootPath, limits: { [name]: value } })).rejects.toEqual(
        new WorkspaceError("invalid-limit", "initialize"),
      );
    },
  );

  it("accepts the inclusive upper limits", async () => {
    const workspace = await openGuardedWorkspace({
      rootPath,
      limits: {
        maxReadBytes: 134_217_728,
        maxWriteBytes: 134_217_728,
        maxDirectoryEntries: 100_000,
      },
    });

    await expect(workspace.list("/")).resolves.toEqual([]);
  });

  it("detects replacement of the canonical root", async () => {
    const workspace = await openGuardedWorkspace({ rootPath });
    await rename(rootPath, `${rootPath}-old`);
    await mkdir(rootPath);

    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("unsafe-entry", "list"));
  });

  it("detects replacement of the root with a link", async ({ skip }) => {
    const workspace = await openGuardedWorkspace({ rootPath });
    await rename(rootPath, `${rootPath}-old`);
    try {
      await symlink(`${rootPath}-old`, rootPath, "dir");
    } catch {
      skip("Symbolic links are unavailable on this platform.");
    }

    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("unsafe-entry", "list"));
  });
});
