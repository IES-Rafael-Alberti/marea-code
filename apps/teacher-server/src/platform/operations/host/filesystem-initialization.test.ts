import { describe, expect, it, vi } from "vitest";
import {
  actualFs,
  createInitializationHandle,
  createMockedLockFixture,
  expectOwnershipChanged,
  lstatMock,
  openMock,
  rm,
} from "./filesystem-test-support.fixture.js";
const { FilesystemInstallationExclusivity } = await import("./filesystem-exclusivity.js");

describe("FilesystemInstallationExclusivity initialization proofs", () => {
  it("rejects every canonical-root identity replacement", async () => {
    const { root } = await createMockedLockFixture();
    const original = await actualFs.lstat(root);
    const replacements = [
      (entry: typeof original) => {
        entry.isSymbolicLink = () => true;
      },
      (entry: typeof original) => {
        entry.isDirectory = () => false;
      },
      (entry: typeof original) => {
        entry.dev = original.dev + 1;
      },
      (entry: typeof original) => {
        entry.ino = original.ino + 1;
      },
    ];
    try {
      for (const replace of replacements) {
        const changed = Object.create(original) as typeof original;
        replace(changed);
        vi.mocked(lstatMock).mockReset();
        vi.mocked(lstatMock).mockResolvedValueOnce(original).mockResolvedValueOnce(changed);
        await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
          code: "path",
          message: "installation root changed during inspection",
        });
      }
    } finally {
      vi.mocked(lstatMock).mockReset();
      vi.mocked(lstatMock).mockImplementation(actualFs.lstat);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for each malformed lock record field", async () => {
    const malformed: unknown[] = [
      null,
      [],
      "primitive",
      {},
      { format: "wrong", token: "token", canonicalRoot: "/root", pid: 1 },
      { format: "marea-installation-lock:1", token: 7, canonicalRoot: "/root", pid: 1 },
      { format: "marea-installation-lock:1", token: "", canonicalRoot: "/root", pid: 1 },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: 7, pid: 1 },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: "", pid: 1 },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: "/root", pid: "1" },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: "/root", pid: 0 },
      { format: "marea-installation-lock:1", token: "token", canonicalRoot: "/root", pid: 1.5 },
    ];
    const { root, lockPath } = await createMockedLockFixture();
    vi.mocked(lstatMock).mockReset();
    vi.mocked(lstatMock).mockImplementation(actualFs.lstat);
    try {
      for (const value of malformed) {
        const handle = createInitializationHandle(lockPath, () =>
          actualFs.writeFile(lockPath, JSON.stringify(value)),
        );
        vi.mocked(openMock).mockResolvedValueOnce(handle as never);
        await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
          code: "owner-busy",
          message:
            typeof value === "string"
              ? "installation lock record is not an object"
              : "installation lock is invalid",
        });
        await rm(lockPath, { force: true });
      }
      let validBody!: Uint8Array;
      const validHandle = {
        writeFile: vi.fn(async (input: Uint8Array) => {
          validBody = input;
          const record = JSON.parse(new TextDecoder().decode(input)) as Record<string, unknown>;
          record.pid = 1;
          await actualFs.writeFile(lockPath, JSON.stringify(record));
        }),
        read: vi.fn((buffer: Buffer) => {
          Buffer.from(validBody).copy(buffer);
          return Promise.resolve({ bytesRead: validBody.byteLength, buffer });
        }),
        close: vi.fn(() => Promise.resolve()),
        stat: vi.fn(() => actualFs.lstat(lockPath)),
        sync: vi.fn(() => Promise.resolve()),
      };
      vi.mocked(openMock).mockResolvedValueOnce(validHandle as never);
      const valid = await new FilesystemInstallationExclusivity().acquire(root);
      await valid.release();
      await expect(valid.release()).resolves.toBeUndefined();
    } finally {
      vi.mocked(lstatMock).mockReset();
      vi.mocked(lstatMock).mockImplementation(actualFs.lstat);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-JSON lock content distinctly from invalid records", async () => {
    const { root, lockPath } = await createMockedLockFixture();
    const handle = {
      writeFile: vi.fn(() => actualFs.writeFile(lockPath, "not-json")),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(() => actualFs.lstat(lockPath)),
      sync: vi.fn(() => Promise.resolve()),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expect(new FilesystemInstallationExclusivity().acquire(root)).rejects.toMatchObject({
      code: "owner-busy",
      message: "installation lock JSON is invalid",
    });
    await rm(root, { recursive: true, force: true });
  });

  it("removes a failed initialization lock only after token, inode, and final checks", async () => {
    type Scenario =
      | "current-inode"
      | "current-symlink"
      | "record-token"
      | "record-root"
      | "final-inode"
      | "final-symlink"
      | "owned";
    const scenarios: Scenario[] = [
      "current-inode",
      "current-symlink",
      "record-token",
      "record-root",
      "final-inode",
      "final-symlink",
      "owned",
    ];
    for (const scenario of scenarios) {
      const { root, lockPath } = await createMockedLockFixture();
      let inspectCalls = 0;
      let body!: Uint8Array;
      const inspectPath = async (path: Parameters<typeof lstatMock>[0]) => {
        const entry = await actualFs.lstat(path);
        inspectCalls += 1;
        if (scenario === "current-inode" && inspectCalls === 3)
          return Object.assign(Object.create(entry), { ino: entry.ino + 1 }) as typeof entry;
        if (scenario === "current-symlink" && inspectCalls === 3) {
          const changed = Object.create(entry) as typeof entry;
          changed.isSymbolicLink = () => true;
          return changed;
        }
        if (scenario === "final-inode" && inspectCalls === 4)
          return Object.assign(Object.create(entry), { ino: entry.ino + 1 }) as typeof entry;
        if (scenario === "final-symlink" && inspectCalls === 4) {
          const changed = Object.create(entry) as typeof entry;
          changed.isSymbolicLink = () => true;
          return changed;
        }
        return entry;
      };
      const handle = {
        writeFile: vi.fn((input: Uint8Array) => {
          body = input;
          return actualFs.writeFile(lockPath, input);
        }),
        close: vi.fn(() => Promise.resolve()),
        stat: vi.fn(() => actualFs.lstat(lockPath)),
        sync: vi.fn(async () => {
          if (scenario === "record-token" || scenario === "record-root") {
            const record = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
            if (scenario === "record-token") record.token = "replacement";
            else record.canonicalRoot = "/replacement";
            await actualFs.writeFile(lockPath, JSON.stringify(record));
          }
          throw new Error("durability failed");
        }),
      };
      vi.mocked(openMock).mockResolvedValueOnce(handle as never);
      try {
        await expect(
          new FilesystemInstallationExclusivity(inspectPath as never).acquire(root),
        ).rejects.toMatchObject({
          code: "path",
          message: "installation lock cannot be initialized",
        });
        if (scenario === "owned")
          await expect(actualFs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        else await expect(actualFs.lstat(lockPath)).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a first verification identity race even if the final check recovers", async () => {
    const { root, lockPath } = await createMockedLockFixture();
    let inspectCalls = 0;
    const inspectPath = async (path: Parameters<typeof lstatMock>[0]) => {
      const entry = await actualFs.lstat(path);
      inspectCalls += 1;
      return inspectCalls === 1
        ? (Object.assign(Object.create(entry), { ino: entry.ino + 1 }) as typeof entry)
        : entry;
    };
    const handle = {
      writeFile: vi.fn((input: Uint8Array) => actualFs.writeFile(lockPath, input)),
      close: vi.fn(() => Promise.resolve()),
      stat: vi.fn(() => actualFs.lstat(lockPath)),
      sync: vi.fn(() => Promise.resolve()),
    };
    vi.mocked(openMock).mockResolvedValueOnce(handle as never);
    await expectOwnershipChanged(
      new FilesystemInstallationExclusivity(inspectPath as never).acquire(root),
    );
    await expect(actualFs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
