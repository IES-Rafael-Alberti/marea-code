import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openGuardedWorkspace } from "@marea/workspace-backend";
import { projectSearchTools } from "./project-search.js";
import { projectGlob } from "./project-glob.js";
it.each([
  ["**/*.ts", "main.ts", true],
  ["**/*.ts", "src/main.ts", true],
  ["*.ts", "src/main.ts", false],
  ["src/?.ts", "src/a.ts", true],
  ["src/?.ts", "src/ab.ts", false],
  ["a", "b", false],
  ["**", "a/b/c", true],
  ["[a]", "[a]", true],
  ["*", "", true],
  ["a*", "a", true],
])("matches %s against %s without regex backtracking", (pattern, path, expected) => {
  expect(projectGlob(pattern, path)).toBe(expected);
});
it("searches guarded files, excludes dependency internals and rejects traversal and links", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-search-"));
  try {
    await mkdir(join(root, "src"));
    for (const name of ["node_modules", ".git", ".venv"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "private.txt"), "needle");
    }
    await writeFile(join(root, "src/main.ts"), "first\nneedle\nlast");
    await writeFile(join(root, "node_modules/private.txt"), "needle");
    const workspace = await openGuardedWorkspace({ rootPath: root });
    const [search, glob] = projectSearchTools(workspace);
    if (search === undefined || glob === undefined) throw new Error("Missing search tools");
    expect(JSON.parse(await search.execute({ query: "needle" }))).toEqual({
      matches: [{ path: "/src/main.ts", line: 2, text: "needle" }],
      truncated: false,
    });
    expect(JSON.parse(await glob.execute({ query: "**/*.ts" }))).toEqual({
      matches: [{ path: "/src/main.ts", line: 0, text: "" }],
      truncated: false,
    });
    await expect(search.execute({ query: "needle", path: "/../" })).rejects.toThrow();
    await symlink("/etc/passwd", join(root, "escape"));
    await expect(search.execute({ query: "root" })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("makes traversal and output limits explicit instead of returning a complete-looking result", async () => {
  const entries = Array.from({ length: 1001 }, (_, index) => ({
    path: `/file${String(index)}.ts`,
    kind: "file" as const,
    size: 0,
    modifiedAt: new Date(0).toISOString(),
  }));
  const workspace = {
    list: () => Promise.resolve(entries),
    readText: () => Promise.resolve("no match"),
  };
  const tools = projectSearchTools(workspace);
  const search = tools.find((tool) => tool.name === "marea_search_project");
  const glob = tools.find((tool) => tool.name === "marea_glob_project");
  if (search === undefined || glob === undefined) throw new Error("Missing tools");
  expect(JSON.parse(await search.execute({ query: "needle" }))).toEqual({
    matches: [],
    truncated: true,
  });
  expect(JSON.parse(await glob.execute({ query: "*.py" }))).toEqual({
    matches: [],
    truncated: true,
  });
  entries.splice(1);
  workspace.readText = () => Promise.resolve("needle".repeat(100));
  expect(await search.execute({ query: "needle" })).toContain('"truncated":true');
  workspace.readText = () =>
    Promise.resolve(Array.from({ length: 201 }, () => "needle").join("\n"));
  const result = JSON.parse(await search.execute({ query: "needle" })) as {
    matches: { path: string; line: number; text: string }[];
    truncated: boolean;
  };
  expect(result.matches).toHaveLength(200);
  expect(result.truncated).toBe(true);
  await expect(search.execute({ query: "" })).rejects.toThrow();
});
it.each(["unsupported-text-encoding", "read-limit-exceeded", "not-found"] as const)(
  "handles %s during guarded search",
  async (code) => {
    const { WorkspaceError } = await import("@marea/workspace-backend");
    const error = new WorkspaceError(code, "read");
    const tools = projectSearchTools({
      list: () =>
        Promise.resolve([
          { path: "/binary", kind: "file", size: 0, modifiedAt: new Date(0).toISOString() },
        ]),
      readText: () => Promise.reject(error),
    });
    const search = tools[0];
    if (search === undefined) throw new Error("Missing search");
    if (code === "not-found") await expect(search.execute({ query: "x" })).rejects.toBe(error);
    else
      expect(JSON.parse(await search.execute({ query: "x" }))).toEqual({
        matches: [],
        truncated: true,
      });
  },
);
it.each([
  ["a", "ab", false],
  ["?", "/", false],
  ["?", "", false],
  ["*", "ab", true],
  ["*", "a/b", false],
  ["a*b", "axc", false],
  ["a*b", "axb", true],
  ["**/b", "a/c/b", true],
  ["**/b", "a/c", false],
  ["**b", "a/cb", true],
  ["*b", "ac", false],
  ["*/b", "b", false],
  ["a?", "a/", false],
  ["ab?c", "abc", false],
  ["a**x", "abc", false],
  ["**/a", "ba", false],
])("preserves path boundaries for %s / %s", (pattern, path, expected) => {
  expect(projectGlob(pattern, path)).toBe(expected);
});
it("bounds adversarial wildcard work instead of exponentially backtracking", () => {
  expect(projectGlob("*a".repeat(40) + "b", "a".repeat(80))).toBe(false);
});
it("honors exact search limits and stops reading once its result budget is exhausted", async () => {
  const { vi } = await import("vitest");
  const entries = Array.from({ length: 1000 }, (_, i) => ({
    path: `/src/nested/file${String(i)}.ts`,
    kind: "file" as const,
    size: 0,
    modifiedAt: new Date(0).toISOString(),
  }));
  const list = vi.fn().mockResolvedValue(entries);
  const readText = vi.fn().mockResolvedValue("x".repeat(512));
  const [search, glob] = projectSearchTools({ list, readText });
  if (search === undefined || glob === undefined) throw new Error("Missing tools");
  expect(search.description).toContain("Search literal file contents");
  expect(glob.description).toContain("Find project files by glob");
  expect(JSON.parse(await glob.execute({ query: "src/nested/file999.ts" }))).toEqual({
    matches: [{ path: "/src/nested/file999.ts", line: 0, text: "" }],
    truncated: false,
  });
  expect(list).toHaveBeenCalledWith("/");
  entries.splice(1);
  expect(JSON.parse(await search.execute({ query: "x" }))).toEqual({
    matches: [{ path: entries[0]?.path, line: 1, text: "x".repeat(512) }],
    truncated: false,
  });
  readText.mockResolvedValue("x".repeat(513));
  expect(JSON.parse(await search.execute({ query: "x" }))).toEqual({
    matches: [{ path: entries[0]?.path, line: 1, text: "x".repeat(512) }],
    truncated: true,
  });
  entries.push({ path: "/second", kind: "file", size: 0, modifiedAt: new Date(0).toISOString() });
  readText.mockClear().mockResolvedValue("x\n".repeat(201));
  await search.execute({ query: "x" });
  expect(readText).toHaveBeenCalledTimes(1);
});

it.each([
  ["src/**/a", "src/x/a", true],
  ["**/a/**", "a/x/y", true],
] as const)("matches nested glob-directory boundaries %s", (pattern, path, expected) => {
  expect(projectGlob(pattern, path)).toBe(expected);
});
