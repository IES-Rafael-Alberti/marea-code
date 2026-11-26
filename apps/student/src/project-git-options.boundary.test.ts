import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { createSystemGitRunner } from "./project-git.boundary.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

it("probes Git without a console window and with a short bound", () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "main\n" } as ReturnType<
    typeof spawnSync
  >);
  expect(createSystemGitRunner()(["rev-parse", "--abbrev-ref", "HEAD"], "/project")).toBe("main");
  expect(spawnSync).toHaveBeenCalledWith("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: "/project",
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
});
