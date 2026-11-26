import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import select from "@inquirer/select";
import { createTranslator } from "@marea/i18n";
import { ensureGitWorkspace, projectGit } from "./git-workspace.boundary.js";

vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
vi.mock("./canonical-path.boundary.js", async (original) => ({
  ...(await original<typeof import("./canonical-path.boundary.js")>()),
  canonicalPath: vi.fn(),
}));
const { canonicalPath } = await import("./canonical-path.boundary.js");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts the repository root when Windows spells the drive and folders in another case", async () => {
  const path = await mkdtemp(join(tmpdir(), "marea-git-case-"));
  roots.push(path);
  await projectGit(path, ["init"]);
  vi.mocked(canonicalPath).mockImplementation((value) =>
    Promise.resolve(value === path ? "C:\\Proj" : "c:\\proj"),
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await ensureGitWorkspace(path, createTranslator("es"));
  expect(select).not.toHaveBeenCalled();
});

it("still reports a different folder on other platforms when only the case differs", async () => {
  const path = await mkdtemp(join(tmpdir(), "marea-git-case-"));
  roots.push(path);
  await projectGit(path, ["init"]);
  vi.mocked(canonicalPath).mockImplementation((value) =>
    Promise.resolve(value === path ? "/Proj" : "/proj"),
  );
  await expect(
    ensureGitWorkspace(path, createTranslator("es"), {
      interactive: false,
      homeDirectory: "/home",
    }),
  ).rejects.toThrow("raíz");
});
