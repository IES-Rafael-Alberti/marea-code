import { afterEach, expect, it, vi } from "vitest";
import select from "@inquirer/select";
import { ensureGitWorkspace } from "./git-workspace.boundary.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
afterEach(() => {
  vi.clearAllMocks();
});

it("still offers initialization when the repository probe fails without any diagnostic text", async () => {
  execute.mockImplementation((_command: string, args: string[]) =>
    args.includes("rev-parse")
      ? Promise.reject(new Error("probe failed"))
      : Promise.resolve({ stdout: "git version", stderr: "" }),
  );
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(ensureGitWorkspace("/synthetic")).rejects.toMatchObject({
    key: "student.git.cancelled",
  });
  expect(select).toHaveBeenCalledOnce();
});
