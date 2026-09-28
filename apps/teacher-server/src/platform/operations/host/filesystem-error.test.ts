import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";
import {
  actualFs,
  createInitializationHandle,
  createMockedLockFixture,
  expectOwnershipChanged,
  expectReplacementRecord,
  lstatMock,
  mkdir,
  openMock,
  rename,
  rm,
  writeFile,
} from "./filesystem-test-support.fixture.js";
const { FilesystemInstallationExclusivity } = await import("./filesystem-exclusivity.js");
const { HostOperationError } = await import("./contracts.js");

describe("FilesystemInstallationExclusivity initialization failures", () => {
  it("rejects a root replaced during canonicalization", async () => {
    const { root } = await createMockedLockFixture();
    const canonicalRoot = await actualFs.realpath(root);
    const original = await actualFs.lstat(canonicalRoot);
    vi.mocked(lstatMock).mockReset();
    vi.mocked(lstatMock).mockResolvedValueOnce(original);
    const changed = Object.create(original) as typeof original;
    changed.ino = original.ino + 1;
    vi.mocked(lstatMock).mockResolvedValueOnce(changed);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation root changed during inspection",
    });
  });

  it("cleans up when lock initialization fails with a generic error", async () => {
    const { root, lockPath } = await createMockedLockFixture();
    const handle = {
      writeFile: vi.fn(async () => {
        await actualFs.writeFile(lockPath, "partial");
        throw new Error("write failed");
      }),
      close: vi.fn(() => Promise.reject(new Error("close failed"))),
      stat: vi.fn(),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be initialized",
    });
    expect(handle.close).toHaveBeenCalledOnce();
    await expect(actualFs.lstat(lockPath)).resolves.toBeDefined();
    await rm(lockPath);
  });

  it("preserves typed lock initialization errors and handles close cleanup errors", async () => {
    const { root } = await createMockedLockFixture();
    const typedHandle = {
      writeFile: vi.fn(() => Promise.reject(new HostOperationError("limit", "too large"))),
      close: vi.fn(() => Promise.reject(new Error("close failed"))),
      stat: vi.fn(),
    };
    vi.mocked(openMock).mockResolvedValueOnce(typedHandle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "limit",
      message: "too large",
    });

    const raceRoot = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const raceError = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.mocked(openMock).mockRejectedValueOnce(raceError);
    await expect(new FilesystemInstallationExclusivity().acquire(raceRoot)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation is already owned",
    });
  });

  it("preserves a replacement created while initialization is failing", async () => {
    const { root, lockPath } = await createMockedLockFixture();
    let realHandle: Awaited<ReturnType<typeof actualFs.open>> | undefined;
    let originalStats: Awaited<ReturnType<typeof actualFs.lstat>> | undefined;
    const handle = {
      writeFile: vi.fn(async (body: Uint8Array) => {
        realHandle = await actualFs.open(lockPath, "w+");
        await realHandle.writeFile(body);
        originalStats = await realHandle.stat();
        await realHandle.close();
        await actualFs.writeFile(lockPath, "replacement-owner");
        throw new Error("write failed after replacement");
      }),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(() => originalStats),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be initialized",
    });
    await expect(actualFs.readFile(lockPath, "utf8")).resolves.toBe("replacement-owner");
    await rm(lockPath);
  });

  it("preserves an invalid lock when ownership cannot be proven during cleanup", async () => {
    const { root, lockPath } = await createMockedLockFixture();
    const handle = {
      writeFile: vi.fn(() => actualFs.writeFile(lockPath, "partial")),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(async () => actualFs.lstat(lockPath)),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock JSON is invalid",
    });
    await expect(actualFs.readFile(lockPath, "utf8")).resolves.toBe("partial");
    await rm(lockPath);
  });

  it("preserves a valid replacement when initialization ownership changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    const handle = createInitializationHandle(lockPath, async (body: Uint8Array) => {
      await actualFs.writeFile(lockPath, body);
      const replacement = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      replacement.token = "replacement-owner";
      await actualFs.writeFile(lockPath, JSON.stringify(replacement));
    });
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expectOwnershipChanged(new FilesystemInstallationExclusivity().acquire(root));
    await expectReplacementRecord(lockPath, "replacement-owner");
  });

  it("rejects a lock whose canonical root changes during initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const lockPath = join(root, ".marea-installation.lock");
    const handle = createInitializationHandle(lockPath, async (body: Uint8Array) => {
      const record = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      record.canonicalRoot = "/replacement-owner";
      await actualFs.writeFile(lockPath, JSON.stringify(record));
    });
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expectOwnershipChanged(new FilesystemInstallationExclusivity().acquire(root));
    await expectReplacementRecord(lockPath, "replacement-owner");
  });

  it("removes its owned lock after durability confirmation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    const handle = {
      writeFile: vi.fn((body: Uint8Array) => actualFs.writeFile(lockPath, body)),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(async () => actualFs.lstat(lockPath)),
      sync: vi.fn(() => Promise.reject(new Error("sync failed"))),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be initialized",
    });
    await expect(actualFs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans its owned lock after a post-write verification race", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    const realLstat = actualFs.lstat;
    const handle = {
      writeFile: vi.fn((body: Uint8Array) => actualFs.writeFile(lockPath, body)),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(async () => {
        const entry = await realLstat(lockPath);
        const changed = Object.create(entry) as typeof entry;
        changed.ino = entry.ino + 1;
        return changed;
      }),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    vi.mocked(lstatMock).mockReset();
    vi.mocked(lstatMock).mockImplementation(realLstat);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await expect(actualFs.lstat(lockPath)).resolves.toBeDefined();
    await rm(lockPath);
  });

  it("preserves a replacement observed during final initialization verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    let body!: Uint8Array;
    const handle = createInitializationHandle(lockPath, (input: Uint8Array) => {
      body = input;
      return actualFs.writeFile(lockPath, input);
    });
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    let lockLookups = 0;
    const inspectPath = async (path: Parameters<typeof lstatMock>[0]) => {
      if (lockLookups++ === 1) {
        const replacementPath = join(canonicalRoot, ".replacement.lock");
        await actualFs.writeFile(replacementPath, body);
        await rename(replacementPath, lockPath);
      }
      return actualFs.lstat(path);
    };
    await expectOwnershipChanged(
      new FilesystemInstallationExclusivity(inspectPath as never).acquire(root),
    );
    await expect(actualFs.lstat(lockPath)).resolves.toBeDefined();
    await rm(lockPath);
  });

  it("fails closed when initialization sees a symbolic-link identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    const handle = createInitializationHandle(lockPath, (body: Uint8Array) =>
      actualFs.writeFile(lockPath, body),
    );
    const inspectPath = async (path: Parameters<typeof lstatMock>[0]) => {
      const entry = await actualFs.lstat(path);
      const changed = Object.create(entry) as typeof entry;
      changed.isSymbolicLink = () => true;
      return changed;
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(
      new FilesystemInstallationExclusivity(inspectPath as never).acquire(root),
    ).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(lockPath);
  });

  it("preserves a replacement observed during initialization cleanup confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    let inspectCalls = 0;
    let body!: Uint8Array;
    const inspectPath = async (path: Parameters<typeof lstatMock>[0]) => {
      if (inspectCalls++ === 3) {
        const replacementPath = join(canonicalRoot, ".replacement.lock");
        await actualFs.writeFile(replacementPath, body);
        await rename(replacementPath, lockPath);
      }
      return actualFs.lstat(path);
    };
    const handle = createInitializationHandle(
      lockPath,
      (input: Uint8Array) => {
        body = input;
        return actualFs.writeFile(lockPath, input);
      },
      () => Promise.reject(new Error("sync failed")),
    );
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(
      new FilesystemInstallationExclusivity(inspectPath as never).acquire(root),
    ).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be initialized",
    });
    await expect(actualFs.lstat(lockPath)).resolves.toBeDefined();
    await rm(lockPath);
  });

  it("refuses release when ownership changes during final confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const canonicalRoot = await actualFs.realpath(root);
    const lockPath = join(canonicalRoot, ".marea-installation.lock");
    vi.mocked(lstatMock).mockReset();
    vi.mocked(lstatMock).mockImplementation(actualFs.lstat);
    const lock = await new FilesystemInstallationExclusivity().acquire(root);
    let lockLookups = 0;
    vi.mocked(lstatMock).mockReset();
    vi.mocked(lstatMock).mockImplementation(async (path) => {
      const entry = await actualFs.lstat(path);
      if (path === lockPath && lockLookups++ === 1)
        return Object.assign(Object.create(entry), { ino: entry.ino + 1 }) as typeof entry;
      return entry;
    });
    await expect(lock.release()).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock ownership changed",
    });
    await rm(lockPath);
  });

  it("maps generic lock creation failures and unknown inspection errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const genericError = Object.assign(new Error("io"), { code: "EIO" });
    vi.mocked(openMock).mockRejectedValueOnce(genericError);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be created",
    });
    const child = join(root, ".marea-installation.lock");
    await mkdir(child);
    expect(await new FilesystemInstallationExclusivity().inspect(root)).toBe("unknown");
    await rm(child, { recursive: true });
    await writeFile(child, "lock");
    expect(await new FilesystemInstallationExclusivity().inspect(root)).toBe("held");
  });

  it("maps non-ENOENT lock inspection errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-host-lock-"));
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(lstatMock).mockResolvedValueOnce(await actualFs.lstat(root));
    vi.mocked(lstatMock).mockResolvedValueOnce(await actualFs.lstat(root));
    vi.mocked(lstatMock).mockRejectedValueOnce(error);
    await expect(new FilesystemInstallationExclusivity().inspect(root)).resolves.toBe("unknown");

    vi.mocked(lstatMock).mockResolvedValueOnce(await actualFs.lstat(root));
    vi.mocked(lstatMock).mockResolvedValueOnce(await actualFs.lstat(root));
    vi.mocked(lstatMock).mockRejectedValueOnce(error);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "path",
      message: "installation lock cannot be inspected",
    });
  });
});
