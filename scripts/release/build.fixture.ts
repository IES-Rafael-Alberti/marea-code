import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  cpSync: vi.fn(),
  withBuildWorkspace: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  spawnSync: vi.fn(),
  ordinaryFiles: vi.fn(),
}));
vi.mock("./workspace.boundary.js", () => mocks);
vi.mock("node:fs", () => mocks);
vi.mock("node:child_process", () => mocks);
vi.mock("./files.boundary.js", () => mocks);
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const arch = Object.getOwnPropertyDescriptor(process, "arch");
assert.ok(platform && arch);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.withBuildWorkspace.mockImplementation(
    (_source: string, _files: unknown, operation: (workspace: string) => string) =>
      operation("/isolated"),
  );
  vi.stubGlobal("Bun", { version: "1.4.0" });
  Object.defineProperty(process, "platform", { value: "darwin" });
  Object.defineProperty(process, "arch", { value: "arm64" });
  mocks.existsSync.mockImplementation((path: string) => path !== "deleted");
  mocks.readFileSync.mockImplementation((path: string) => {
    if (path === "apps/student/package.json")
      return JSON.stringify({ dependencies: { "@opentui/react": "0.5.10" } });
    if (path.endsWith("sbom.cdx.json"))
      return JSON.stringify({
        bomFormat: "CycloneDX",
        components: [
          { name: "@opentui/core", version: "0.5.10", licenses: [{ license: { id: "MIT" } }] },
          { name: `@opentui/core-${process.platform}-${process.arch}`, version: "0.5.10" },
        ],
      });
    return Buffer.from("binary");
  });
  mocks.ordinaryFiles.mockReturnValue(["marea", "dashboard/index.html"]);
  mocks.spawnSync.mockImplementation((command: string, args: string[]) => ({
    status: 0,
    stdout:
      command === "git" && args[0] === "rev-parse"
        ? "a".repeat(40)
        : args[0] === "ls-files"
          ? "tracked\0deleted\0new\0"
          : "",
    stderr: "",
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", arch);
});

export function buildMocks() {
  return mocks;
}

export function expectStudentSmoke(executable: string): void {
  expect(mocks.withBuildWorkspace).toHaveBeenLastCalledWith(
    process.cwd(),
    [],
    expect.any(Function),
  );
  const options = {
    cwd: "/isolated",
    encoding: "utf8",
    env: { ...process.env, MAREA_STATE_HOME: "/isolated/state" },
  };
  expect(mocks.spawnSync.mock.calls.slice(-2)).toEqual([
    [executable, ["--lang", "en", "--help"], options],
    [executable, ["--version"], options],
  ]);
}
