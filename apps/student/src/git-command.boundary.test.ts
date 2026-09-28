import { afterEach, expect, it, vi } from "vitest";
import { projectGit } from "./git-workspace.boundary.js";

const { execute } = vi.hoisted(() => ({
  execute: vi.fn<(...args: readonly object[]) => Promise<{ stdout: string }>>(),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execute,
  }),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it.each(["unexpected.configuration", "prefixfilter.name.clean", "filter.name.cleanSuffix"])(
  "rejects malformed enumeration key %s before a content operation",
  async (key) => {
    execute.mockResolvedValue({ stdout: key + "\0" });
    await expect(projectGit("/synthetic", ["add", "file"])).rejects.toThrow(
      "Invalid Git filter configuration.",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

it("does not confuse a process failure without an exit status with no configured filters", async () => {
  const failure = new Error("Synthetic process spawn failure");
  execute.mockRejectedValue(failure);
  await expect(projectGit("/synthetic", ["status"])).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("preserves command configuration and child-only transport restrictions when no filters match", async () => {
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "'marea.synthetic=preserved'");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "ssh");
  vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
  execute.mockRejectedValueOnce(Object.assign(new Error("No matching keys"), { code: 1 }));
  execute.mockResolvedValueOnce({ stdout: "Synthetic clean status" });
  await expect(projectGit("/synthetic", ["status"])).resolves.toBe("Synthetic clean status");
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]?.[1]).toContain("--ignore-submodules=dirty");
  expect(execute.mock.calls[1]?.[2]).toMatchObject({
    env: {
      GIT_CONFIG_PARAMETERS: "'marea.synthetic=preserved'",
      GIT_ALLOW_PROTOCOL: "",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  expect(process.env.GIT_ALLOW_PROTOCOL).toBe("ssh");
  expect(process.env.GIT_NO_LAZY_FETCH).toBe("0");
});

it("permits Git's empty invocation without content configuration enumeration", async () => {
  execute.mockResolvedValue({ stdout: "Synthetic Git help" });
  await expect(projectGit("/synthetic", [])).resolves.toBe("Synthetic Git help");
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(["status", "add", "read-tree", "write-tree", "diff"])(
  "fails closed on malformed filter configuration before automatic %s",
  async (command) => {
    execute.mockResolvedValue({ stdout: "unexpected.configuration\0" });
    await expect(projectGit("/synthetic", [command])).rejects.toThrow(
      "Invalid Git filter configuration.",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toContain("config");
  },
);
