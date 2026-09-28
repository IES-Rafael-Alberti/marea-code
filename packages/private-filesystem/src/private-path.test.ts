import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentOwnerId, inspectPrivatePath, securePrivatePath } from "./index.js";
import * as windows from "./windows-acl.boundary.js";

const platform = process.platform;
const roots: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "marea-private-path-"));
  roots.push(path);
  chmodSync(path, 0o700);
  return path;
}

describe("POSIX private state", () => {
  it("requires invoking owner and rejects group/other permissions", () => {
    const directory = root();
    const path = join(directory, "state");
    writeFileSync(path, "private", { mode: 0o600 });
    expect(currentOwnerId()).toBe(process.getuid?.());
    expect(inspectPrivatePath(directory)).toBe("directory");
    expect(inspectPrivatePath(path)).toBe("file");
    expect(inspectPrivatePath(path, currentOwnerId() + 1)).toBeUndefined();
    chmodSync(path, 0o640);
    expect(inspectPrivatePath(path)).toBeUndefined();
    chmodSync(path, 0o601);
    expect(inspectPrivatePath(path)).toBeUndefined();
    securePrivatePath(path, 0o600);
    expect(inspectPrivatePath(path)).toBe("file");
    chmodSync(directory, 0o755);
    expect(inspectPrivatePath(directory)).toBeUndefined();
    securePrivatePath(directory, 0o700);
    expect(inspectPrivatePath(directory)).toBe("directory");
  });
  it("does not accept missing files or symbolic links", () => {
    const directory = root();
    const link = join(directory, "alias");
    symlinkSync(directory, link);
    expect(inspectPrivatePath(link)).toBeUndefined();
    expect(() => inspectPrivatePath(join(directory, "missing"))).toThrow();
    const pipe = join(directory, "pipe");
    execFileSync("mkfifo", [pipe]);
    chmodSync(pipe, 0o600);
    expect(inspectPrivatePath(pipe)).toBeUndefined();
  });
});

describe("Windows dispatch", () => {
  it("uses the SID adapter instead of POSIX ownership or mode bits", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const inspect = vi.spyOn(windows, "windowsPrivateKind").mockReturnValue("file");
    expect(currentOwnerId()).toBe(0);
    expect(inspectPrivatePath("C:\\state")).toBe("file");
    expect(inspect).toHaveBeenCalledWith("C:\\state", "inspect");
    expect(inspectPrivatePath("C:\\state", 123)).toBeUndefined();
    expect(inspect).toHaveBeenCalledTimes(1);
    securePrivatePath("C:\\state", 0o600);
    expect(inspect).toHaveBeenLastCalledWith("C:\\state", "secure");
    inspect.mockReturnValue("directory");
    securePrivatePath("C:\\root", 0o700);
    expect(inspect).toHaveBeenLastCalledWith("C:\\root", "secure");
    expect(() => {
      securePrivatePath("C:\\root", 0o600);
    }).toThrow("Private filesystem permissions could not be established.");
    inspect.mockReturnValue(undefined);
    expect(() => {
      securePrivatePath("C:\\root", 0o700);
    }).toThrow();
    expect(inspectPrivatePath("C:\\root")).toBeUndefined();
  });
});
