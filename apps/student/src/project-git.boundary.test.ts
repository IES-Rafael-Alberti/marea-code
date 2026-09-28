import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSystemGitRunner,
  firstOutputLine,
  readProjectGitContext,
} from "./project-git.boundary.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "marea-git-"));
  temporary.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

describe("project git context", () => {
  it.each([
    { output: "main\n", expected: "main" },
    { output: "main", expected: "main" },
    { output: "  spaced  \nrest", expected: "spaced" },
    { output: "", expected: "" },
    { output: "\n", expected: "" },
  ])("reads the first output line: $output", ({ output, expected }) => {
    expect(firstOutputLine(output)).toBe(expected);
  });

  it("maps a stubbed runner to the banner context", () => {
    const values: Record<string, string | null> = {
      "remote get-url origin": "https://example.invalid/class/repo.git",
      "rev-parse --abbrev-ref HEAD": "trunk",
    };
    expect(readProjectGitContext("/project", (args) => values[args.join(" ")] ?? null)).toEqual({
      branch: "trunk",
      repositoryUrl: "https://example.invalid/class/repo.git",
    });
  });

  it("maps missing git values to empty rows", () => {
    expect(readProjectGitContext("/project", () => null)).toEqual({
      branch: "",
      repositoryUrl: "",
    });
  });

  it("reads the branch and remote of a synthetic repository", () => {
    const root = temporaryDirectory();
    git(root, ["init"]);
    git(root, ["checkout", "-b", "class-branch"]);
    git(root, ["config", "user.email", "synthetic@example.invalid"]);
    git(root, ["config", "user.name", "Synthetic"]);
    git(root, ["commit", "--allow-empty", "--message", "synthetic root"]);
    git(root, ["remote", "add", "origin", "https://example.invalid/class/repo.git"]);
    expect(readProjectGitContext(root, createSystemGitRunner())).toEqual({
      branch: "class-branch",
      repositoryUrl: "https://example.invalid/class/repo.git",
    });
  });

  it("reads empty rows outside a repository", () => {
    expect(readProjectGitContext(temporaryDirectory(), createSystemGitRunner())).toEqual({
      branch: "",
      repositoryUrl: "",
    });
  });

  it("reads empty rows with the system runner outside a repository", () => {
    expect(readProjectGitContext(temporaryDirectory())).toEqual({
      branch: "",
      repositoryUrl: "",
    });
  });

  it("reads empty rows when git cannot start", () => {
    const root = temporaryDirectory();
    const file = join(root, "notes.txt");
    writeFileSync(file, "synthetic notes\n");
    expect(readProjectGitContext(file, createSystemGitRunner())).toEqual({
      branch: "",
      repositoryUrl: "",
    });
  });
});
