import { afterEach, expect, it, vi } from "vitest";
import select from "@inquirer/select";
import { createTranslator } from "@marea/i18n";
import { ensureGitWorkspace } from "./git-workspace.boundary.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./canonical-path.boundary.js", async (original) => ({
  ...(await original<typeof import("./canonical-path.boundary.js")>()),
  canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
}));
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function git(revParse: () => Promise<{ stdout: string; stderr: string }>) {
  execute.mockImplementation((_command: string, args: string[]) =>
    args.includes("rev-parse")
      ? revParse()
      : Promise.resolve({ stdout: "git version", stderr: "" }),
  );
}
function distrusted(path: string) {
  return Promise.reject(
    Object.assign(new Error("Command failed"), {
      stderr: `fatal: detected dubious ownership in repository at '${path}'\n`,
    }),
  );
}

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

it("does not offer to create a repository where Git distrusts the owner", async () => {
  git(() => distrusted("/synthetic"));
  for (const language of ["es", "en", "eu"] as const) {
    await expect(ensureGitWorkspace("/synthetic", createTranslator(language))).rejects.toThrow(
      'safe.directory "/synthetic"',
    );
  }
  expect(select).not.toHaveBeenCalled();
  await expect(ensureGitWorkspace("/synthetic")).rejects.toMatchObject({
    key: "student.git.dubious-ownership",
  });
  expect(execute.mock.calls.some(([, args]) => (args as string[]).includes("init"))).toBe(false);
});

it("writes the folder in the safe.directory command with forward slashes", async () => {
  git(() => distrusted("C:\\Users\\student\\proj"));
  await expect(ensureGitWorkspace("C:\\Users\\student\\proj")).rejects.toThrow(
    'safe.directory "C:/Users/student/proj"',
  );
});

function topLevel(path: string) {
  git(() => Promise.resolve({ stdout: `${path}\n`, stderr: "" }));
}

it("accepts the repository root when Windows spells the drive and folders in another case", async () => {
  topLevel("c:\\proj");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await expect(ensureGitWorkspace("C:\\Proj")).resolves.toBeUndefined();
  expect(select).not.toHaveBeenCalled();
});

it("still reports a different folder on other platforms when only the case differs", async () => {
  topLevel("/proj");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  await expect(
    ensureGitWorkspace("/Proj", createTranslator("es"), {
      interactive: false,
      homeDirectory: "/home",
    }),
  ).rejects.toThrow("raíz");
});
