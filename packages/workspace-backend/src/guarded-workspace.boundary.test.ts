import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./filesystem.boundary.js", () => ({
  createDirectory: vi.fn(),
  decodeUtf8: vi.fn(),
  inspectPath: vi.fn(),
  movePath: vi.fn(),
  readBoundedFile: vi.fn(),
  readNames: vi.fn(),
  removeEmptyDirectory: vi.fn(),
  removeRegularFile: vi.fn(),
  removeTemporaryFile: vi.fn(),
  resolveRealPath: vi.fn(),
  writeExclusiveFile: vi.fn(),
}));

import { WorkspaceError } from "./contracts.js";
import {
  createDirectory,
  decodeUtf8,
  inspectPath,
  movePath,
  readBoundedFile,
  readNames,
  removeTemporaryFile,
  resolveRealPath,
  writeExclusiveFile,
} from "./filesystem.boundary.js";
import { openGuardedWorkspace } from "./guarded-workspace.js";

const ROOT_PATH = resolve("mock-workspace");
const OUTSIDE_PATH = join(dirname(ROOT_PATH), "outside");
const inspectPathMock = vi.mocked(inspectPath);
const createDirectoryMock = vi.mocked(createDirectory);
const movePathMock = vi.mocked(movePath);
const resolveRealPathMock = vi.mocked(resolveRealPath);
const readNamesMock = vi.mocked(readNames);
const readBoundedFileMock = vi.mocked(readBoundedFile);
const decodeUtf8Mock = vi.mocked(decodeUtf8);
const writeExclusiveFileMock = vi.mocked(writeExclusiveFile);
const removeTemporaryFileMock = vi.mocked(removeTemporaryFile);

describe("guarded workspace revalidation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const root = directoryStats();
    inspectPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === ROOT_PATH ? root : fileStats()),
    );
    resolveRealPathMock.mockImplementation((hostPath) => Promise.resolve(hostPath));
    readNamesMock.mockResolvedValue([]);
    readBoundedFileMock.mockResolvedValue(new TextEncoder().encode("old"));
    decodeUtf8Mock.mockImplementation((content) => new TextDecoder().decode(content));
    createDirectoryMock.mockResolvedValue(undefined);
    movePathMock.mockResolvedValue(undefined);
    writeExclusiveFileMock.mockResolvedValue(undefined);
    removeTemporaryFileMock.mockResolvedValue(false);
  });

  it("rejects a canonical root that resolves elsewhere after initialization", async () => {
    resolveRealPathMock.mockResolvedValueOnce(ROOT_PATH).mockResolvedValueOnce(OUTSIDE_PATH);
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("unsafe-entry", "list"));
  });

  it("rejects an ambiguous root even when the filesystem would accept it", async () => {
    inspectPathMock.mockResolvedValue(directoryStats());
    resolveRealPathMock.mockResolvedValue(resolve("   "));

    await expect(openGuardedWorkspace({ rootPath: "   " })).rejects.toEqual(
      new WorkspaceError("invalid-root", "initialize"),
    );
  });

  it.each([specialStats(), directoryStats({ symbolicLink: true })])(
    "rejects an unsafe canonical target produced during initialization",
    async (unsafeRoot) => {
      inspectPathMock.mockResolvedValueOnce(directoryStats()).mockResolvedValueOnce(unsafeRoot);
      resolveRealPathMock.mockResolvedValue(ROOT_PATH);

      await expect(openGuardedWorkspace({ rootPath: ROOT_PATH })).rejects.toEqual(
        new WorkspaceError("invalid-root", "initialize"),
      );
    },
  );

  it.each([undefined, directoryStats({ symbolicLink: true }), specialStats()])(
    "rejects an invalid root observed during an operation",
    async (changedRoot) => {
      let rootInspections = 0;
      inspectPathMock.mockImplementation(() => {
        rootInspections += 1;
        return Promise.resolve(rootInspections < 3 ? directoryStats() : changedRoot);
      });
      const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

      await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("unsafe-entry", "list"));
    },
  );

  it("rejects an existing entry whose real path is outside the root", async () => {
    const filePath = join(ROOT_PATH, "file");
    resolveRealPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === filePath ? OUTSIDE_PATH : hostPath),
    );
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.readText("/file")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
  });

  it("rejects an existing entry that resolves to the root's parent", async () => {
    const filePath = join(ROOT_PATH, "file");
    resolveRealPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === filePath ? dirname(ROOT_PATH) : hostPath),
    );
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.readText("/file")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
  });

  it("fails a listing when an entry disappears after readdir", async () => {
    const vanishedPath = join(ROOT_PATH, "vanished");
    inspectPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === vanishedPath ? undefined : directoryStats()),
    );
    readNamesMock.mockResolvedValue(["vanished"]);
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.list("/")).rejects.toEqual(new WorkspaceError("not-found", "list"));
  });

  it("rejects unsupported filesystem entry types for every relevant operation", async () => {
    const specialPath = join(ROOT_PATH, "special");
    inspectPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === specialPath ? specialStats() : directoryStats()),
    );
    readNamesMock.mockResolvedValue(["special"]);
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.readText("/special")).rejects.toEqual(
      new WorkspaceError("not-regular-file", "read"),
    );
    await expect(
      workspace.editText("/special", { expected: "old", replacement: "new" }),
    ).rejects.toEqual(new WorkspaceError("not-regular-file", "edit"));
    await expect(workspace.deleteEntry("/special")).rejects.toEqual(
      new WorkspaceError("not-directory", "delete"),
    );
    await expect(workspace.renameEntry("/special", "/moved")).rejects.toEqual(
      new WorkspaceError("not-regular-file", "rename"),
    );
    await expect(workspace.list("/")).rejects.toEqual(
      new WorkspaceError("not-regular-file", "list"),
    );
    await expect(workspace.list("/special")).rejects.toEqual(
      new WorkspaceError("not-directory", "list"),
    );
  });

  it("rejects a non-directory physical ancestor even if a child appears to exist", async () => {
    const parentPath = join(ROOT_PATH, "parent");
    inspectPathMock.mockImplementation((hostPath) =>
      Promise.resolve(hostPath === ROOT_PATH ? directoryStats() : fileStats()),
    );
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.readText("/parent/child")).rejects.toEqual(
      new WorkspaceError("not-directory", "read"),
    );
    expect(parentPath).not.toBe(ROOT_PATH);
  });

  it("rejects a non-directory destination parent before writing", async () => {
    const parentPath = join(ROOT_PATH, "parent");
    inspectPathMock.mockImplementation((hostPath) => {
      if (hostPath === ROOT_PATH) {
        return Promise.resolve(directoryStats());
      }
      return Promise.resolve(hostPath === parentPath ? fileStats() : undefined);
    });
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.writeText("/parent/child", "content")).rejects.toEqual(
      new WorkspaceError("not-directory", "write"),
    );
    expect(writeExclusiveFileMock).not.toHaveBeenCalled();
  });

  it("does not recreate an edit parent that disappears during the operation", async () => {
    const parentPath = join(ROOT_PATH, "parent");
    const filePath = join(parentPath, "file");
    let parentInspections = 0;
    let recreated = false;
    inspectPathMock.mockImplementation((hostPath) => {
      if (hostPath === ROOT_PATH) {
        return Promise.resolve(directoryStats());
      }
      if (hostPath === filePath) {
        return Promise.resolve(fileStats());
      }
      parentInspections += 1;
      return Promise.resolve(parentInspections === 1 || recreated ? directoryStats() : undefined);
    });
    createDirectoryMock.mockImplementation(() => {
      recreated = true;
      return Promise.resolve();
    });
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(
      workspace.editText("/parent/file", { expected: "old", replacement: "new" }),
    ).rejects.toEqual(new WorkspaceError("not-found", "edit"));
    expect(createDirectoryMock).not.toHaveBeenCalled();
  });

  it.each([
    ["device", fileStats({ dev: 2 })],
    ["inode", fileStats({ ino: 2 })],
    ["size", fileStats({ size: 2 })],
    ["modification time", fileStats({ mtimeMs: 2 })],
    ["change time", fileStats({ ctimeMs: 2 })],
    ["availability", undefined],
  ] as const)("rejects an edit when target $0 changes", async (_change, changedFile) => {
    const filePath = join(ROOT_PATH, "file");
    mockFileChangeAt(filePath, changedFile);
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(
      workspace.editText("/file", { expected: "old", replacement: "new" }),
    ).rejects.toEqual(new WorkspaceError("edit-conflict", "edit"));
  });

  it.each(["file", "directory"] as const)(
    "reports an unsafe %s that changes before deletion",
    async (kind) => {
      const entryPath = join(ROOT_PATH, "entry");
      let entryInspections = 0;
      inspectPathMock.mockImplementation((hostPath) => {
        if (hostPath === ROOT_PATH) {
          return Promise.resolve(directoryStats());
        }
        entryInspections += 1;
        const initial = kind === "file" ? fileStats() : directoryStats();
        return Promise.resolve(entryInspections === 1 ? initial : fileStats({ ino: 2 }));
      });
      const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

      await expect(workspace.deleteEntry("/entry")).rejects.toEqual(
        new WorkspaceError("unsafe-entry", "delete"),
      );
      expect(entryPath).not.toBe(ROOT_PATH);
    },
  );

  it("reports an unsafe source that changes before rename", async () => {
    const sourcePath = join(ROOT_PATH, "source");
    let sourceInspections = 0;
    inspectPathMock.mockImplementation((hostPath) => {
      if (hostPath === ROOT_PATH) {
        return Promise.resolve(directoryStats());
      }
      if (hostPath === sourcePath) {
        sourceInspections += 1;
        return Promise.resolve(sourceInspections === 1 ? fileStats() : fileStats({ ino: 2 }));
      }
      return Promise.resolve(undefined);
    });
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.renameEntry("/source", "/destination")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "rename"),
    );
  });

  it("rejects a changed destination parent before creating a temporary file", async () => {
    mockRootChangeAfter(4, directoryStats({ ino: 2 }));
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.writeText("/file", "content")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "write"),
    );
    expect(writeExclusiveFileMock).not.toHaveBeenCalled();
  });

  it.each([undefined, specialStats()])(
    "rejects an unavailable or non-directory destination parent during revalidation",
    async (changedRoot) => {
      mockRootChangeAfter(4, changedRoot);
      const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

      await expect(workspace.writeText("/file", "content")).rejects.toEqual(
        new WorkspaceError("unsafe-entry", "write"),
      );
      expect(writeExclusiveFileMock).not.toHaveBeenCalled();
    },
  );

  it("does not remove a temporary path when exclusive creation fails", async () => {
    writeExclusiveFileMock.mockRejectedValue(new WorkspaceError("filesystem-failure", "write"));
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.writeText("/file", "content")).rejects.toEqual(
      new WorkspaceError("filesystem-failure", "write"),
    );
    expect(removeTemporaryFileMock).not.toHaveBeenCalled();
  });

  it("does not clean up after a successful atomic replacement", async () => {
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.writeText("/file", "content")).resolves.toBeUndefined();
    expect(removeTemporaryFileMock).not.toHaveBeenCalled();
  });

  it("cleans up when the destination parent changes after the temporary write", async () => {
    mockRootChangeAfter(5, directoryStats({ dev: 2 }));
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.writeText("/file", "content")).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "write"),
    );
    expect(writeExclusiveFileMock).toHaveBeenCalledOnce();
    expect(removeTemporaryFileMock).toHaveBeenCalledOnce();
  });

  it("serializes competing no-clobber renames", async () => {
    const firstSource = join(ROOT_PATH, "first");
    const secondSource = join(ROOT_PATH, "second");
    const destination = join(ROOT_PATH, "destination");
    let destinationExists = false;
    inspectPathMock.mockImplementation((hostPath) => {
      if (hostPath === destination) {
        return Promise.resolve(destinationExists ? fileStats() : undefined);
      }
      return Promise.resolve(hostPath === ROOT_PATH ? directoryStats() : fileStats());
    });
    movePathMock.mockImplementation((_source, destinationPath) => {
      destinationExists = destinationPath === destination;
      return Promise.resolve();
    });
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    const firstRename = workspace.renameEntry("/first", "/destination");
    const secondRename = workspace.renameEntry("/second", "/destination");

    await expect(firstRename).resolves.toBeUndefined();
    await expect(secondRename).rejects.toEqual(new WorkspaceError("already-exists", "rename"));
    expect(movePathMock).toHaveBeenCalledOnce();
    expect(movePathMock).toHaveBeenCalledWith(firstSource, destination, "rename");
    expect(secondSource).not.toBe(firstSource);
  });

  it("sorts listings independently of filesystem enumeration order", async () => {
    readNamesMock.mockResolvedValue(["z", "a"]);
    const workspace = await openGuardedWorkspace({ rootPath: ROOT_PATH });

    await expect(workspace.list("/")).resolves.toEqual([
      expect.objectContaining({ path: "/a" }),
      expect.objectContaining({ path: "/z" }),
    ]);
  });
});

interface StatsOverrides {
  readonly dev?: number;
  readonly ino?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
  readonly symbolicLink?: boolean;
}

function directoryStats(overrides: StatsOverrides = {}): Stats {
  return stats("directory", overrides);
}

function fileStats(overrides: StatsOverrides = {}): Stats {
  return stats("file", overrides);
}

function specialStats(): Stats {
  return stats("special", {});
}

function mockFileChangeAt(filePath: string, changedFile: Stats | undefined): void {
  let fileInspections = 0;
  inspectPathMock.mockImplementation((hostPath) => {
    if (hostPath !== filePath) {
      return Promise.resolve(directoryStats());
    }
    fileInspections += 1;
    return Promise.resolve(fileInspections === 1 ? fileStats() : changedFile);
  });
}

function mockRootChangeAfter(stableInspections: number, changedRoot: Stats | undefined): void {
  const stableRoot = directoryStats();
  let rootInspections = 0;
  inspectPathMock.mockImplementation((hostPath) => {
    if (hostPath !== ROOT_PATH) {
      return Promise.resolve(undefined);
    }
    rootInspections += 1;
    return Promise.resolve(rootInspections < stableInspections ? stableRoot : changedRoot);
  });
}

function stats(kind: "directory" | "file" | "special", overrides: StatsOverrides): Stats {
  return {
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 1,
    size: overrides.size ?? (kind === "file" ? 3 : 0),
    mtimeMs: overrides.mtimeMs ?? 1,
    ctimeMs: overrides.ctimeMs ?? 1,
    mode: 0o600,
    nlink: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => overrides.symbolicLink ?? false,
    mtime: new Date(0),
  } as Stats;
}
