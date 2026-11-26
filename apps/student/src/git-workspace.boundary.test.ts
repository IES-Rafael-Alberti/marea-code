import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import select from "@inquirer/select";
import { createTranslator } from "@marea/i18n";
import { ensureGitWorkspace, projectGit, hasErrorCode } from "./git-workspace.boundary.js";
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "marea-git-preflight-"));
  roots.push(path);
  return path;
}
it("initializes only with consent, protects an existing ignore file and requires the repository root", async () => {
  const path = await root();
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(ensureGitWorkspace(path)).rejects.toThrow("vuelve a iniciar");
  await expect(stat(join(path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(path, ".gitignore"), "private/\n");
  vi.mocked(select).mockResolvedValueOnce(true);
  await ensureGitWorkspace(path);
  expect(await readFile(join(path, ".gitignore"), "utf8")).toBe("private/\n");
  await ensureGitWorkspace(path);
  expect(select).toHaveBeenCalledTimes(2);
  await mkdir(join(path, "nested"));
  await expect(ensureGitWorkspace(join(path, "nested"))).rejects.toThrow("raíz");
});
it("creates default ignores and reports a missing Git executable", async () => {
  const path = await root();
  vi.mocked(select).mockResolvedValueOnce(true);
  await ensureGitWorkspace(path);
  expect(await readFile(join(path, ".gitignore"), "utf8")).toContain(".env");
  expect((await projectGit(path, ["status", "--porcelain"])).trim()).toBe("?? .gitignore");
  vi.stubEnv("PATH", "/nonexistent-marea-synthetic-path");
  await expect(ensureGitWorkspace(path)).rejects.toThrow("Instala Git");
});
it("propagates an ignore-file filesystem failure after initialization", async () => {
  const path = await root();
  const { chmod } = await import("node:fs/promises");
  vi.mocked(select).mockImplementationOnce(async () => {
    await projectGit(path, ["init"]);
    await chmod(path, 0o500);
    return true;
  });
  try {
    await expect(ensureGitWorkspace(path)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(path, 0o700);
  }
});

it("presents an explicit initialization choice and accepts only a matching error code", async () => {
  const path = await root();
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(ensureGitWorkspace(path)).rejects.toThrow();
  expect(vi.mocked(select).mock.lastCall?.[0].message).toContain("¿Crearlo en esta carpeta?");
  expect(vi.mocked(select).mock.lastCall?.[0].choices).toEqual([
    { name: "Sí, crear repositorio", value: true },
    { name: "Cancelar", value: false },
  ]);
  expect(hasErrorCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
  expect(hasErrorCode({ code: "EACCES" }, "ENOENT")).toBe(false);
  expect(hasErrorCode(new Error("no code"), "ENOENT")).toBe(false);
  expect(hasErrorCode(null, "ENOENT")).toBe(false);
});
it("localizes the repository preflight through the interface translator", async () => {
  const path = await root();
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(ensureGitWorkspace(path, createTranslator("en"))).rejects.toThrow(
    "Create the repository when you are ready",
  );
  expect(vi.mocked(select).mock.lastCall?.[0].message).toContain("Marea needs a Git repository");
  expect(vi.mocked(select).mock.lastCall?.[0].choices).toEqual([
    { name: "Yes, create repository", value: true },
    { name: "Cancel", value: false },
  ]);
});
it("uses the requested private index and never enables interactive Git prompts", async () => {
  const path = await root();
  await projectGit(path, ["init"]);
  await writeFile(join(path, "code.txt"), "synthetic");
  const index = join(path, "private-index");
  await projectGit(path, ["add", "code.txt"], index);
  await expect(stat(join(path, ".git/index"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await projectGit(path, ["ls-files"], index)).toBe("code.txt\n");
  vi.stubEnv("GIT_INDEX_FILE", index);
  expect(await projectGit(path, ["ls-files"])).toBe("code.txt\n");
  await projectGit(path, ["config", "alias.promptstate", '!printf %s "$GIT_TERMINAL_PROMPT"']);
  vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
  expect(await projectGit(path, ["promptstate"])).toBe("0");
  await projectGit(path, ["config", "alias.localestate", '!printf %s "$LC_ALL"']);
  expect(await projectGit(path, ["localestate"])).toBe("C");
});

async function nestedProject() {
  const parent = await realpath(await root());
  await projectGit(parent, ["init"]);
  const current = join(parent, "unidad-2");
  await mkdir(current);
  return { parent, current };
}

const terminal = (interactive: boolean, homeDirectory = tmpdir()) => ({
  interactive,
  homeDirectory,
});

it("explains both folders without a terminal and creates nothing", async () => {
  const { parent, current } = await nestedProject();
  await expect(
    ensureGitWorkspace(current, createTranslator("es"), terminal(false)),
  ).rejects.toMatchObject({
    key: "student.git.not-root",
    message: `Marea debe ejecutarse desde la carpeta raíz de tu proyecto. Estás en ${current}, pero el repositorio Git empieza en ${parent}.\nEjecuta cd "${parent}" y vuelve a lanzar marea.`,
  });
  expect(select).not.toHaveBeenCalled();
  await expect(stat(join(current, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("offers to leave, by default, or to create a repository in the current folder", async () => {
  const { parent, current } = await nestedProject();
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(
    ensureGitWorkspace(current, createTranslator("en"), terminal(true)),
  ).rejects.toMatchObject({ key: "student.git.not-root" });
  expect(vi.mocked(select).mock.lastCall?.[0]).toEqual({
    message: `Marea must run from your project's root folder. You are in ${current}, but the Git repository starts at ${parent}.`,
    choices: [
      { name: `Exit (Run cd "${parent}" and start marea again.)`, value: false },
      { name: `Create a new repository in ${current}`, value: true },
    ],
  });
  await expect(stat(join(current, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  vi.mocked(select).mockResolvedValueOnce(true);
  await ensureGitWorkspace(current, createTranslator("en"), terminal(true));
  expect(await realpath((await projectGit(current, ["rev-parse", "--show-toplevel"])).trim())).toBe(
    current,
  );
  expect(await readFile(join(current, ".gitignore"), "utf8")).toContain("node_modules/");
  await ensureGitWorkspace(current, createTranslator("en"), terminal(true));
  expect(select).toHaveBeenCalledTimes(2);
});

it("says when the repository above is the home folder", async () => {
  const { parent, current } = await nestedProject();
  vi.mocked(select).mockResolvedValueOnce(false);
  await expect(
    ensureGitWorkspace(current, createTranslator("es"), terminal(true, parent)),
  ).rejects.toMatchObject({ key: "student.git.not-root" });
  expect(vi.mocked(select).mock.lastCall?.[0].message).toBe(
    `Marea debe ejecutarse desde la carpeta raíz de tu proyecto. Estás en ${current}, pero el repositorio Git empieza en ${parent}.\nEse repositorio ocupa tu carpeta personal; probablemente se creó por error.`,
  );
  await expect(
    ensureGitWorkspace(current, createTranslator("es"), terminal(false, parent)),
  ).rejects.toThrow("probablemente se creó por error.\nEjecuta cd");
});

it.each([
  [true, true, 1],
  [true, false, 0],
  [false, true, 0],
] as const)(
  "asks only when both standard input and output are terminals (%s, %s)",
  async (input, output, asked) => {
    const { current } = await nestedProject();
    const descriptors = [process.stdin, process.stdout].map((stream) =>
      Object.getOwnPropertyDescriptor(stream, "isTTY"),
    );
    Object.defineProperty(process.stdin, "isTTY", { value: input, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: output, configurable: true });
    try {
      vi.mocked(select).mockResolvedValueOnce(false);
      await expect(ensureGitWorkspace(current)).rejects.toMatchObject({
        key: "student.git.not-root",
      });
      expect(select).toHaveBeenCalledTimes(asked);
    } finally {
      for (const [index, stream] of [process.stdin, process.stdout].entries()) {
        const descriptor = descriptors[index];
        if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
        else Object.defineProperty(stream, "isTTY", descriptor);
      }
    }
  },
);
