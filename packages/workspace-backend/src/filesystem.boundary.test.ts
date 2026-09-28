import type { Stats } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rmdir: vi.fn(),
  unlink: vi.fn(),
}));

import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { WorkspaceError } from "./contracts.js";
import {
  createDirectory,
  decodeUtf8,
  inspectPath,
  movePath,
  readBoundedFile,
  readNames,
  removeEmptyDirectory,
  removeRegularFile,
  removeTemporaryFile,
  resolveRealPath,
  writeExclusiveFile,
} from "./filesystem.boundary.js";

const lstatMock = vi.mocked(lstat);
const mkdirMock = vi.mocked(mkdir);
const openMock = vi.mocked(open);
const readdirMock = vi.mocked(readdir);
const realpathMock = vi.mocked(realpath);
const renameMock = vi.mocked(rename);
const rmdirMock = vi.mocked(rmdir);
const unlinkMock = vi.mocked(unlink);

describe("filesystem boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns path metadata and treats ENOENT as an absent optional path", async () => {
    const metadata = fileStats();
    lstatMock.mockResolvedValueOnce(metadata).mockRejectedValueOnce(errno("ENOENT"));

    await expect(inspectPath("host-path", "read")).resolves.toBe(metadata);
    await expect(inspectPath("missing", "read")).resolves.toBeUndefined();
  });

  it.each([
    ["ENOENT", "not-found"],
    ["EEXIST", "already-exists"],
    ["ENOTDIR", "not-directory"],
    ["ENOTEMPTY", "directory-not-empty"],
    ["EISDIR", "not-regular-file"],
    ["ELOOP", "unsafe-entry"],
    ["ENAMETOOLONG", "invalid-path"],
    ["EACCES", "filesystem-failure"],
  ] as const)("maps native %s errors to %s", async (nativeCode, publicCode) => {
    realpathMock.mockRejectedValue(errno(nativeCode));

    await expect(resolveRealPath("host-path", "read")).rejects.toEqual(
      new WorkspaceError(publicCode, "read"),
    );
  });

  it("maps non-native and lstat failures without leaking their details", async () => {
    lstatMock.mockRejectedValue(new Error("private detail"));
    realpathMock.mockRejectedValue({ code: "ENOENT" });

    await expect(inspectPath("host-path", "list")).rejects.toEqual(
      new WorkspaceError("filesystem-failure", "list"),
    );
    await expect(resolveRealPath("host-path", "read")).rejects.toEqual(
      new WorkspaceError("filesystem-failure", "read"),
    );
  });

  it("preserves an owned error raised inside a filesystem action", async () => {
    const ownedError = new WorkspaceError("read-limit-exceeded", "read");
    realpathMock.mockRejectedValue(ownedError);

    await expect(resolveRealPath("host-path", "read")).rejects.toBe(ownedError);
  });

  it("delegates directory and mutation primitives", async () => {
    readdirMock.mockResolvedValue(["one", "two"] as never);
    mkdirMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    rmdirMock.mockResolvedValue(undefined);
    renameMock.mockResolvedValue(undefined);

    await expect(readNames("directory", "list")).resolves.toEqual(["one", "two"]);
    await expect(createDirectory("directory", "write")).resolves.toBeUndefined();
    await expect(removeRegularFile("file", "delete")).resolves.toBeUndefined();
    await expect(removeEmptyDirectory("directory", "delete")).resolves.toBeUndefined();
    await expect(movePath("source", "destination", "rename")).resolves.toBeUndefined();
    expect(mkdirMock).toHaveBeenCalledWith("directory", { mode: 0o700 });
    expect(renameMock).toHaveBeenCalledWith("source", "destination");
  });

  it("reads a bounded file until EOF and always closes it", async () => {
    const expected = fileStats();
    const handle = readHandle(expected, [Uint8Array.from([65, 66]), Uint8Array.from([67])]);
    openMock.mockResolvedValue(handle as never);

    await expect(readBoundedFile("file", "read", 3, expected)).resolves.toEqual(
      Uint8Array.from([65, 66, 67]),
    );
    expect(handle.createReadStream).toHaveBeenCalledWith({
      autoClose: false,
      end: 3,
      start: 0,
    });
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects growth beyond the read limit after opening", async () => {
    const expected = fileStats({ size: 1 });
    const handle = readHandle(expected, [Uint8Array.from([1, 2])]);
    openMock.mockResolvedValue(handle as never);

    await expect(readBoundedFile("file", "read", 1, expected)).rejects.toEqual(
      new WorkspaceError("read-limit-exceeded", "read"),
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects a file already larger than the read limit after opening", async () => {
    const expected = fileStats({ size: 2 });
    const handle = readHandle(expected, []);
    openMock.mockResolvedValue(handle as never);

    await expect(readBoundedFile("file", "read", 1, expected)).rejects.toEqual(
      new WorkspaceError("read-limit-exceeded", "read"),
    );
    expect(handle.createReadStream).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects a non-binary chunk from the filesystem stream", async () => {
    const expected = fileStats();
    const stream = iterateChunks(["invalid", Uint8Array.of(1)]);
    const next = vi.spyOn(stream, "next");
    const handle = {
      stat: vi.fn().mockResolvedValue(expected),
      createReadStream: vi.fn(() => stream),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openMock.mockResolvedValue(handle as never);

    await expect(readBoundedFile("file", "read", 1, expected)).rejects.toEqual(
      new WorkspaceError("filesystem-failure", "read"),
    );
    expect(next).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([
    fileStats({ isFile: false }),
    fileStats({ nlink: 2 }),
    fileStats({ dev: 2 }),
    fileStats({ ino: 2 }),
  ])("rejects an opened file whose physical identity is unsafe", async (current) => {
    const expected = fileStats();
    const handle = readHandle(current, []);
    openMock.mockResolvedValue(handle as never);

    await expect(readBoundedFile("file", "read", 2, expected)).rejects.toEqual(
      new WorkspaceError("unsafe-entry", "read"),
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("writes, syncs, and closes an exclusive temporary file", async () => {
    const handle = writeHandle();
    openMock.mockResolvedValue(handle as never);
    const content = Uint8Array.from([1, 2, 3]);

    await expect(writeExclusiveFile("temporary", "write", content, 0o640)).resolves.toBeUndefined();
    expect(handle.writeFile).toHaveBeenCalledWith(content);
    expect(handle.sync).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("closes a temporary file when its write fails", async () => {
    const handle = writeHandle();
    vi.mocked(handle.writeFile).mockRejectedValue(errno("EACCES"));
    openMock.mockResolvedValue(handle as never);
    unlinkMock.mockResolvedValue(undefined);

    await expect(writeExclusiveFile("temporary", "write", Uint8Array.of(1), 0o600)).rejects.toEqual(
      new WorkspaceError("filesystem-failure", "write"),
    );
    expect(handle.sync).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(unlinkMock).toHaveBeenCalledWith("temporary");
  });

  it("never removes a colliding path that it did not create", async () => {
    openMock.mockRejectedValue(errno("EEXIST"));

    await expect(writeExclusiveFile("collision", "write", Uint8Array.of(1), 0o600)).rejects.toEqual(
      new WorkspaceError("already-exists", "write"),
    );
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("removes a temporary file and ignores cleanup failure", async () => {
    unlinkMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(errno("EACCES"));

    await expect(removeTemporaryFile("temporary")).resolves.toBe(true);
    await expect(removeTemporaryFile("temporary")).resolves.toBe(false);
  });

  it("decodes valid UTF-8 and rejects invalid input", () => {
    expect(decodeUtf8(Uint8Array.from([104, 105]), "read")).toBe("hi");
    expect(() => decodeUtf8(Uint8Array.of(0xff), "read")).toThrow(
      new WorkspaceError("unsupported-text-encoding", "read"),
    );
  });
});

interface StatsOverrides {
  readonly size?: number;
  readonly nlink?: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly isFile?: boolean;
}

function fileStats(overrides: StatsOverrides = {}): Stats {
  return {
    size: overrides.size ?? 0,
    nlink: overrides.nlink ?? 1,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 1,
    isFile: () => overrides.isFile ?? true,
  } as Stats;
}

function errno(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`private ${code}`), { code });
}

function readHandle(current: Stats, chunks: readonly Uint8Array[]) {
  return {
    stat: vi.fn().mockResolvedValue(current),
    createReadStream: vi.fn(() => iterateChunks(chunks)),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function* iterateChunks<Chunk>(chunks: readonly Chunk[]): Generator<Chunk> {
  yield* chunks;
}

function writeHandle() {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
