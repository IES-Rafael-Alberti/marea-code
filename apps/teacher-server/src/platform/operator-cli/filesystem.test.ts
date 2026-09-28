import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { currentUid, isInside, privateKind, privateDescendantKind } from "./private-path.js";
import { acquireInstallation } from "./installation-lock.js";
import { boundedJson, prepareArtifact, publishArtifact } from "./artifact.js";
import { cleanupInstallations, temporaryInstallation } from "./filesystem.fixture.js";

vi.mock("node:fs", async (load) => {
  const original = await load<typeof import("node:fs")>();
  return {
    ...original,
    openSync: vi.fn(original.openSync),
    closeSync: vi.fn(original.closeSync),
    fstatSync: vi.fn(original.fstatSync),
    lstatSync: vi.fn(original.lstatSync),
    unlinkSync: vi.fn(original.unlinkSync),
    fsyncSync: vi.fn(original.fsyncSync),
    writeFileSync: vi.fn(original.writeFileSync),
    linkSync: vi.fn(original.linkSync),
    mkdtempSync: vi.fn(original.mkdtempSync),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanupInstallations();
  vi.clearAllMocks();
});

describe("private installation paths", () => {
  it("requires owned private files/directories and exact subtree boundaries", () => {
    const root = temporaryInstallation();
    const file = join(root, "private.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    expect(currentUid()).toBe(process.getuid?.());
    const uid = currentUid();
    expect(privateKind(root, uid)).toBe("directory");
    expect(privateKind(file, uid)).toBe("file");
    expect(privateKind(file, uid + 1)).toBeUndefined();
    fs.chmodSync(file, 0o640);
    expect(privateKind(file, uid)).toBeUndefined();
    fs.chmodSync(file, 0o601);
    expect(privateKind(file, uid)).toBeUndefined();
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, join(root, "link"));
    expect(privateKind(join(root, "link"), uid)).toBeUndefined();
    expect(isInside(root, root)).toBe(true);
    expect(isInside(file, root)).toBe(true);
    expect(isInside(`${root}-other/file`, root)).toBe(false);
    expect(isInside(root, file)).toBe(false);
    expect(privateDescendantKind(root, file, uid)).toBe("file");
    vi.mocked(fs.lstatSync).mockClear();
    expect(privateDescendantKind(root, root, uid)).toBeUndefined();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(privateDescendantKind(root, join(root, "link"), uid)).toBeUndefined();
    const other = temporaryInstallation();
    expect(privateDescendantKind(root, other, uid)).toBeUndefined();
    const path = join(root, "work", "nested");
    fs.mkdirSync(path, { mode: 0o700 });
    expect(privateDescendantKind(root, path, uid)).toBe("directory");
    fs.chmodSync(join(root, "work"), 0o710);
    expect(privateDescendantKind(root, path, uid)).toBeUndefined();
    fs.chmodSync(join(root, "work"), 0o700);
    expect(() => privateDescendantKind(root, join(root, "missing"), uid)).toThrow();
    const status = fs.lstatSync(file);
    vi.mocked(fs.lstatSync).mockReturnValueOnce(
      Object.assign(status, { isFile: () => false, isDirectory: () => false }),
    );
    expect(privateKind(file, uid)).toBeUndefined();
  });
});

describe("exclusive offline installation ownership", () => {
  it("creates only a private lock, rejects contention, verifies ownership and releases once", () => {
    const root = temporaryInstallation();
    const path = join(root, "locks/installation.lock");
    const owned = acquireInstallation(root);
    expect(owned.capability.kind).toBe("exclusive-installation-owner");
    expect(owned.capability.installationRoot).toBe(root);
    expect(Object.isFrozen(owned.capability)).toBe(true);
    owned.capability.assertOwned();
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ pid: process.pid });
    expect(() => acquireInstallation(root)).toThrow("installation-busy");
    const opened = vi.mocked(fs.openSync).mock.results.find((result) => result.type === "return");
    if (opened?.type !== "return" || typeof opened.value !== "number")
      throw new Error("missing descriptor");
    const descriptor = opened.value;
    expect(owned.release()).toBe(true);
    expect(owned.release()).toBe(true);
    expect(() => fs.fstatSync(descriptor)).toThrow();
    expect(fs.existsSync(path)).toBe(false);
    expect(() => {
      owned.capability.assertOwned();
    }).toThrow("installation-lost");
  });
  it("rejects unavailable, aliased, nonprivate and foreign roots or lock directories", () => {
    const root = temporaryInstallation();
    const uid = currentUid();
    for (const path of ["relative", `${root}/.`, `${root}/`, join(root, "missing")])
      expect(() => acquireInstallation(path)).toThrow("installation-unavailable");
    expect(() => acquireInstallation(root, uid + 1)).toThrow("installation-unavailable");
    fs.chmodSync(root, 0o755);
    expect(() => acquireInstallation(root)).toThrow("installation-unavailable");
    fs.chmodSync(root, 0o700);
    fs.chmodSync(join(root, "locks"), 0o750);
    expect(() => acquireInstallation(root)).toThrow("installation-unavailable");
    fs.chmodSync(join(root, "locks"), 0o700);
    fs.renameSync(join(root, "locks"), join(root, "moved"));
    fs.symlinkSync(join(root, "moved"), join(root, "locks"));
    expect(() => acquireInstallation(root)).toThrow("installation-unavailable");
    expect(fs.existsSync(join(root, "moved/installation.lock"))).toBe(false);
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw new Error("private");
    });
    expect(() => acquireInstallation(temporaryInstallation())).toThrow("installation-unavailable");
    const foreign = new Proxy(new Error("foreign filesystem error"), {
      getPrototypeOf: () => null,
    });
    Object.defineProperty(foreign, "code", { value: "EEXIST" });
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw foreign;
    });
    expect(() => acquireInstallation(temporaryInstallation())).toThrow("installation-unavailable");
  });
  it("never removes a replaced, missing or insecure lock and caches failed release", () => {
    for (const change of ["replace", "missing", "permissions", "locks", "root"] as const) {
      const root = temporaryInstallation();
      const path = join(root, "locks/installation.lock");
      const owned = acquireInstallation(root);
      if (change === "replace" || change === "missing") fs.renameSync(path, join(root, "old.lock"));
      if (change === "replace") fs.writeFileSync(path, "foreign", { mode: 0o600 });
      if (change === "permissions") fs.chmodSync(path, 0o644);
      if (change === "locks") fs.chmodSync(join(root, "locks"), 0o755);
      if (change === "root") fs.chmodSync(root, 0o755);
      expect(() => {
        owned.capability.assertOwned();
      }).toThrow("installation-lost");
      expect(owned.release()).toBe(false);
      expect(owned.release()).toBe(false);
      if (change === "replace") expect(fs.readFileSync(path, "utf8")).toBe("foreign");
      expect(() => {
        owned.capability.assertOwned();
      }).toThrow("installation-lost");
    }
  });
  it("detects a replaced root or locks directory even when its original lock is hard-linked", () => {
    for (const which of ["root", "locks"] as const) {
      const parent = temporaryInstallation();
      const root = join(parent, "owned");
      fs.mkdirSync(root, { mode: 0o700 });
      fs.mkdirSync(join(root, "locks"), { mode: 0o700 });
      const owned = acquireInstallation(root);
      const target = which === "root" ? root : join(root, "locks");
      fs.renameSync(target, `${target}-old`);
      fs.mkdirSync(target, { mode: 0o700 });
      if (which === "root") fs.mkdirSync(join(root, "locks"), { mode: 0o700 });
      const original =
        which === "root"
          ? `${root}-old/locks/installation.lock`
          : `${root}/locks-old/installation.lock`;
      const replacement = join(root, "locks/installation.lock");
      fs.linkSync(original, replacement);
      expect(() => {
        owned.capability.assertOwned();
      }).toThrow("installation-lost");
      expect(owned.release()).toBe(false);
      expect(fs.existsSync(replacement)).toBe(true);
    }
  });
  it("closes descriptors on failed inspection and retains uncertain locks after close/unlink failure", () => {
    const root = temporaryInstallation();
    vi.mocked(fs.fstatSync).mockImplementationOnce(() => {
      throw new Error("private");
    });
    const closes = vi.mocked(fs.closeSync).mock.calls.length;
    expect(() => acquireInstallation(root)).toThrow("installation-unavailable");
    expect(vi.mocked(fs.closeSync).mock.calls.length).toBe(closes + 1);
    expect(fs.existsSync(join(root, "locks/installation.lock"))).toBe(true);
    const second = temporaryInstallation();
    const owned = acquireInstallation(second);
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
      throw new Error("private");
    });
    expect(owned.release()).toBe(false);
    expect(owned.release()).toBe(false);
    expect(fs.existsSync(join(second, "locks/installation.lock"))).toBe(true);
    expect(() => {
      owned.capability.assertOwned();
    }).toThrow("installation-lost");
  });
  it("detects a replaced root with the original locks directory and a new alias in its ancestry", () => {
    for (const change of ["root", "ancestor"] as const) {
      const parent = temporaryInstallation();
      const branch = join(parent, "branch");
      const root = join(branch, "root");
      fs.mkdirSync(branch, { mode: 0o700 });
      fs.mkdirSync(root, { mode: 0o700 });
      fs.mkdirSync(join(root, "locks"), { mode: 0o700 });
      const owned = acquireInstallation(root);
      if (change === "root") {
        fs.renameSync(root, join(branch, "previous"));
        fs.mkdirSync(root, { mode: 0o700 });
        fs.renameSync(join(branch, "previous/locks"), join(root, "locks"));
      } else {
        fs.renameSync(branch, join(parent, "previous"));
        fs.symlinkSync(join(parent, "previous"), branch);
      }
      expect(() => {
        owned.capability.assertOwned();
      }).toThrow("installation-lost");
      expect(owned.release()).toBe(false);
      expect(fs.existsSync(join(root, "locks/installation.lock"))).toBe(true);
    }
  });
});

describe("bounded create-only artifacts", () => {
  it("requires a prepared destination before accessing any filesystem state", () => {
    expect(() => {
      publishArtifact(undefined, Buffer.from("{}"));
    }).toThrow("output-failed");
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it("validates exact UTF-8 size and refuses non-JSON values", () => {
    const value = { text: "é界" };
    const expected = Buffer.from(JSON.stringify(value));
    expect(boundedJson(value, expected.length)).toEqual(expected);
    expect(() => boundedJson(value, expected.length - 1)).toThrow("output-failed");
    expect(() => boundedJson(undefined, 100)).toThrow();
    expect(() => boundedJson(1n, 100)).toThrow();
  });
  it("publishes immutable 0600 bytes through an owned stage and removes that stage", () => {
    const root = temporaryInstallation();
    const path = join(root, "work/export.json");
    const prepared = prepareArtifact(root, [join(root, "locks")], path);
    expect(prepared.path).toBe(path);
    prepared.assertParent();
    const bytes = Buffer.from('{"private":"content"}');
    publishArtifact(prepared, bytes);
    expect(fs.readFileSync(path)).toEqual(bytes);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(join(root, "work"))).toEqual(["export.json"]);
    expect(vi.mocked(fs.fsyncSync).mock.calls).toHaveLength(2);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
    expect(fs.mkdtempSync).toHaveBeenCalledWith(join(root, "work/.marea-artifact-"));
    for (const result of vi.mocked(fs.openSync).mock.results) {
      if (result.type === "return") expect(fs.closeSync).toHaveBeenCalledWith(result.value);
    }
    expect(() => {
      publishArtifact(prepared, Buffer.from("overwrite"));
    }).toThrow("output-failed");
    expect(fs.readFileSync(path)).toEqual(bytes);
  });
  it("rejects existing names, symlinks, aliases, nonprivate parents and reserved files or directories", () => {
    const root = temporaryInstallation();
    const reserved = [join(root, "locks"), join(root, "db-wal")];
    fs.writeFileSync(join(root, "existing"), "unchanged");
    fs.symlinkSync(join(root, "missing"), join(root, "dangling"));
    fs.symlinkSync(join(root, "work"), join(root, "alias"));
    for (const path of [
      join(root, "existing"),
      join(root, "dangling"),
      `${root}/./out`,
      "relative",
      root,
      `${root}/new/`,
      join(root, "locks/new"),
      join(root, "db-wal"),
      join(root, "alias/new"),
      join(root, "missing/new"),
    ])
      expect(() => prepareArtifact(root, reserved, path)).toThrow("invalid-input");
    fs.chmodSync(join(root, "work"), 0o755);
    expect(() => prepareArtifact(root, reserved, join(root, "work/new"))).toThrow("invalid-input");
    const prepared = prepareArtifact(root, reserved, join(root, "out"));
    prepared.assertParent();
  });
  it("rejects an artifact parent remounted on a different device even with the same inode", () => {
    const root = temporaryInstallation();
    const prepared = prepareArtifact(root, [], join(root, "work/out"));
    const before = fs.lstatSync(join(root, "work"));
    vi.mocked(fs.lstatSync).mockReturnValueOnce(Object.assign(before, { dev: before.dev + 1 }));
    expect(() => {
      prepared.assertParent();
    }).toThrow("output-failed");
  });
  it("revalidates parent identity and privacy after asynchronous work", () => {
    for (const change of ["move", "permissions"] as const) {
      const root = temporaryInstallation();
      const parent = join(root, "work");
      const prepared = prepareArtifact(root, [], join(parent, "out"));
      if (change === "move") {
        fs.renameSync(parent, `${parent}-old`);
        fs.mkdirSync(parent, { mode: 0o700 });
      } else fs.chmodSync(parent, 0o755);
      expect(() => {
        prepared.assertParent();
      }).toThrow("output-failed");
      expect(() => {
        publishArtifact(prepared, Buffer.from("secret"));
      }).toThrow("output-failed");
      expect(fs.readdirSync(parent)).toEqual([]);
    }
  });
  it("never replaces a racing destination and cleans up write/flush failures", () => {
    const root = temporaryInstallation();
    const path = join(root, "work/out");
    const prepared = prepareArtifact(root, [], path);
    fs.symlinkSync(join(root, "missing"), path);
    expect(() => {
      publishArtifact(prepared, Buffer.from("secret"));
    }).toThrow("output-failed");
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    for (const failure of ["stage", "write", "flush"] as const) {
      const output = prepareArtifact(root, [], join(root, "work", failure));
      if (failure === "stage")
        vi.mocked(fs.mkdtempSync).mockImplementationOnce(() => {
          throw new Error("private");
        });
      if (failure === "write")
        vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
          throw new Error("private");
        });
      if (failure === "flush")
        vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
          throw new Error("private");
        });
      expect(() => {
        publishArtifact(output, Buffer.from("private"));
      }).toThrow("output-failed");
      expect(fs.existsSync(output.path)).toBe(false);
    }
    expect(fs.readdirSync(join(root, "work"))).toEqual(["out"]);
  });
});
