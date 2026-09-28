import { appendGitConfigParameters } from "./git-config-parameters.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { projectGit } from "./git-workspace.boundary.js";
import { describeProject } from "./project-description.boundary.js";
import { GitProjectEvidence } from "./git-evidence.boundary.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marea-git-config-security-"));
  const directory = await mkdtemp(join(tmpdir(), "marea-git-private-security-"));
  directories.push(root, directory);
  await projectGit(root, ["init"]);
  await writeFile(join(root, "code.txt"), "synthetic\n");
  await projectGit(root, ["add", "code.txt"]);
  return { root, directory };
}
it("automatic description disables repository fsmonitor", async () => {
  const { root } = await fixture();
  await projectGit(root, [
    "config",
    "core.fsmonitor",
    "printf synthetic > fsmonitor-marker; printf '\\0'",
  ]);
  await describeProject(root);
  await expect(readFile(join(root, "fsmonitor-marker"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it.each([
  ["local", "synthetic"],
  ["include", "synthetic"],
  ["global", "synthetic"],
  ["local", "x=y"],
  ["local", "x'y"],
  ["local", "x\\y"],
  ["local", "inherited"],
] as const)(
  "automatic evidence bypasses %s filter %s while ordinary Git retains it",
  async (source, filterName) => {
    const { root, directory } = await fixture();
    const config = join(directory, "filter-config");
    const command = "printf synthetic > filter-marker; cat >/dev/null; printf FILTERED";
    if (source === "local") {
      await projectGit(root, ["config", `filter.${filterName}.clean`, command]);
      await projectGit(root, ["config", `filter.${filterName}.required`, "true"]);
    } else {
      await writeFile(
        config,
        '[filter "synthetic"]\n clean = "' + command + '"\n required = true\n',
      );
      if (source === "include") await projectGit(root, ["config", "include.path", config]);
      else vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    }
    const repositoryConfig = await readFile(join(root, ".git/config"));
    const inherited = appendGitConfigParameters(undefined, [
      [`filter.${filterName}.clean`, command],
      ["marea.synthetic", "preserved"],
    ]);
    if (filterName === "inherited") vi.stubEnv("GIT_CONFIG_PARAMETERS", inherited);
    const originalEnv = { ...process.env };
    await writeFile(join(root, ".gitattributes"), `*.txt filter=${filterName}\n`);
    await writeFile(join(root, "code.txt"), "first raw content\n");
    await describeProject(root);
    const session = createFixtureController();
    await session.controller.start("Synthetic security fixture");
    const evidence = new GitProjectEvidence({
      root,
      directory,
      localSession: session.localSession,
      ids: new FixtureIds(),
    });
    await evidence.start();
    await writeFile(join(root, "code.txt"), "second raw content\n");
    await evidence.capture("student");
    const changes = (await session.localSession.pendingEvents(128)).filter(
      (event) => event.eventType === "project-change",
    );
    expect(changes.at(-1)?.patch).toContain("-first raw content");
    expect(changes.at(-1)?.patch).toContain("+second raw content");
    expect(JSON.stringify(changes)).not.toContain("FILTERED");
    await expect(readFile(join(root, "filter-marker"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".git/config"))).toEqual(repositoryConfig);
    expect(process.env).toEqual(originalEnv);
    if (filterName === "inherited")
      expect(await projectGit(root, ["config", "--get", "marea.synthetic"])).toBe("preserved\n");
    // Ordinary user Git commands still execute the configured filter.
    await promisify(execFile)("git", ["add", "code.txt"], { cwd: root });
    const staged = await promisify(execFile)("git", ["show", ":code.txt"], { cwd: root });
    expect(staged.stdout).toBe("FILTERED");
    expect(await readFile(join(root, "filter-marker"), "utf8")).toBe("synthetic");
  },
);

it("neutralizes required process and smudge helpers without starting a process", async () => {
  const { root } = await fixture();
  for (const kind of ["process", "smudge"])
    await projectGit(root, [
      "config",
      `filter.synthetic.${kind}`,
      "printf synthetic > process-marker; exit 1",
    ]);
  await projectGit(root, ["config", "filter.synthetic.required", "true"]);
  await writeFile(join(root, ".gitattributes"), "*.txt filter=synthetic\n");
  await writeFile(join(root, "code.txt"), "raw\n");
  await describeProject(root);
  await projectGit(root, ["add", "code.txt"]);
  expect(await projectGit(root, ["show", ":code.txt"])).toBe("raw\n");
  await expect(readFile(join(root, "process-marker"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed on malformed effective configuration", async () => {
  const { root } = await fixture();
  const config = join(root, ".git/config");
  const original = await readFile(config, "utf8");
  await writeFile(config, original + "\n[malformed\n");
  await writeFile(join(root, "code.txt"), "unstaged raw content\n");
  await expect(projectGit(root, ["add", "code.txt"])).rejects.toThrow();
  await writeFile(config, original);
  expect(await projectGit(root, ["show", ":code.txt"])).toBe("synthetic\n");
});

it("encodes Git command-scope keys and values separately without shell evaluation", () => {
  expect(
    appendGitConfigParameters("'inherited.key=value'", [
      ["filter.x=y.clean", ""],
      ["filter.x'y.process", ""],
      ["filter.x\\y.required", "false"],
    ]),
  ).toBe(
    String.raw`'inherited.key=value' 'filter.x=y.clean'='' 'filter.x'\''y.process'='' 'filter.x\y.required'='false'`,
  );
});

it("rejects newline keys rather than ignoring unsupported configuration", async () => {
  const { root } = await fixture();
  await expect(
    projectGit(root, ["config", "filter.x\ny.clean", "printf synthetic > newline-marker"]),
  ).rejects.toThrow();
  await expect(readFile(join(root, "newline-marker"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([undefined, ""])(
  "encodes a missing or empty inherited prefix without padding: %s",
  (prefix) => {
    expect(appendGitConfigParameters(prefix, [["filter.synthetic.clean", ""]])).toBe(
      "'filter.synthetic.clean'=''",
    );
    expect(appendGitConfigParameters(prefix, [])).toBe("");
  },
);
