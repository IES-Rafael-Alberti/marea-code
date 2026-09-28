import { describe, expect, it, vi } from "vitest";

import { snapshot } from "./deepagents-runtime.fixture.js";
import { createRuntimeReadTools } from "./runtime-read-tools.js";
import { readToolPage } from "./read-tool-page.js";

function fixture() {
  return {
    snapshot: snapshot(),
    workspace: {
      readText: vi.fn(() => Promise.resolve("Project text.")),
      list: vi.fn(() =>
        Promise.resolve([
          {
            path: "src",
            kind: "directory" as const,
            size: 0,
            modifiedAt: "2026-09-08T00:00:00.000Z",
          },
        ]),
      ),
    },
    skills: { read: vi.fn(() => Promise.resolve("Frozen skill text.")) },
  };
}

describe("student controlled read tools", () => {
  it("exposes only explicit read operations and delegates validated arguments", async () => {
    const options = fixture();
    const tools = createRuntimeReadTools(options);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual([
      "marea_read_project",
      "marea_list_project",
      "marea_read_skill",
      "marea_search_project",
      "marea_glob_project",
    ]);
    expect(tools.slice(0, 3).map((tool) => tool.description)).toEqual(
      [
        "Read UTF-8 project text. Arguments: path, a virtual path such as /src/main.ts (root is the project).",
        "List a project directory as JSON text. Arguments: path; use / for the project root.",
        "Read a frozen didactic skill. Arguments: skillId from the run manifest, path must name a file (SKILL.md or an exact resource file referenced there), not a directory. Do not guess resource paths.",
      ].map(
        (description) =>
          description +
          " Returns JSON with content, offset, nextOffset and totalLength; pass nextOffset as the optional string offset to continue. Offsets count UTF-16 code units.",
      ),
    );
    expect(await tools[0]?.execute({ path: "/src/main.ts" })).toBe(
      readToolPage("Project text.", 0),
    );
    expect(await tools[1]?.execute({ path: "/" })).toBe(
      readToolPage(JSON.stringify(await options.workspace.list()), 0),
    );
    expect(await tools[2]?.execute({ skillId: "marea/testing", path: "resources/guide.txt" })).toBe(
      readToolPage("Frozen skill text.", 0),
    );
    expect(options.workspace.readText).toHaveBeenCalledWith("/src/main.ts");
    expect(options.workspace.list).toHaveBeenCalledWith("/");
    expect(options.skills.read).toHaveBeenCalledWith("marea/testing", "resources/guide.txt");
  });

  it.each(["deny", "require-approval"] as const)(
    "does not grant automatic read access for %s rules",
    (effect) => {
      const options = fixture();
      options.snapshot = {
        ...options.snapshot,
        teacherToolPolicy: {
          version: "tools:restricted",
          restrictions: ["read_file", "list_directory", "read_skill"].map((tool) => ({
            tool,
            effect,
          })),
        },
      };
      expect(createRuntimeReadTools(options)).toEqual([]);
      expect(options.workspace.readText).not.toHaveBeenCalled();
      expect(options.skills.read).not.toHaveBeenCalled();
    },
  );

  it("omits didactic access in free mode without disabling project inspection", () => {
    const options = fixture();
    expect(
      createRuntimeReadTools({
        ...options,
        snapshot: { ...options.snapshot, agentMode: "free" },
      }).map((tool) => tool.name),
    ).toEqual([
      "marea_read_project",
      "marea_list_project",
      "marea_search_project",
      "marea_glob_project",
    ]);
  });

  it("rejects invalid and extra arguments before backend access", async () => {
    const options = fixture();
    const tools = createRuntimeReadTools(options);
    expect(() => tools[0]?.execute({ path: "" })).toThrow();
    expect(() => tools[0]?.execute({ path: "file", content: "write" })).toThrow();
    await expect(tools[1]?.execute({})).rejects.toThrow();
    expect(() => tools[2]?.execute({ path: "SKILL.md" })).toThrow();
    expect(() => tools[2]?.execute({ skillId: "", path: "SKILL.md" })).toThrow();
    expect(() =>
      tools[2]?.execute({ skillId: "marea/testing", path: "SKILL.md", execute: "true" }),
    ).toThrow();
    expect(options.workspace.readText).not.toHaveBeenCalled();
    expect(options.workspace.list).not.toHaveBeenCalled();
    expect(options.skills.read).not.toHaveBeenCalled();
  });

  it("reads every kind of content from explicit offsets and rejects malformed offsets before access", async () => {
    const options = fixture();
    const tools = createRuntimeReadTools(options);
    const inputs = [
      { path: "/exercise.txt" },
      { path: "/" },
      { skillId: "marea/testing", path: "SKILL.md" },
    ];
    const texts = [
      "Project text.",
      JSON.stringify(await options.workspace.list()),
      "Frozen skill text.",
    ];
    for (const [index, tool] of tools.slice(0, 3).entries()) {
      const input = inputs[index];
      const text = texts[index];
      if (input === undefined || text === undefined) throw new Error("Missing read test.");
      expect(await tool.execute({ ...input, offset: "2" })).toBe(readToolPage(text, 2));
      expect(await tool.execute({ ...input, offset: "0" })).toBe(readToolPage(text, 0));
      for (const offset of ["-1", "1.1", " 1", "01", "", "1e2", "10000000000000", "0\n", "a"]) {
        await expect(
          Promise.resolve().then(() => tool.execute({ ...input, offset })),
        ).rejects.toThrow();
      }
      await expect(
        Promise.resolve().then(() => tool.execute({ ...input, offset: "9999999999999" })),
      ).rejects.toThrow("The read offset is past the end of the content.");
    }
    expect(options.workspace.readText).toHaveBeenCalledTimes(3);
    expect(options.workspace.list).toHaveBeenCalledTimes(4);
    expect(options.skills.read).toHaveBeenCalledTimes(3);
  });
});
it.each([
  ["grep", ["marea_glob_project"]],
  ["glob", ["marea_search_project"]],
  ["read_file", ["marea_glob_project"]],
  ["list_directory", []],
] as const)("applies the %s restriction independently to search capabilities", (tool, expected) => {
  const options = fixture();
  const tools = createRuntimeReadTools({
    ...options,
    snapshot: {
      ...options.snapshot,
      teacherToolPolicy: { version: "tools:separate", restrictions: [{ tool, effect: "deny" }] },
    },
  });
  expect(
    tools
      .filter(
        (candidate) =>
          candidate.name === "marea_search_project" || candidate.name === "marea_glob_project",
      )
      .map((candidate) => candidate.name),
  ).toEqual(expected);
});

it("hides Git metadata by final path segment without hiding ordinary nested directories", async () => {
  const options = fixture();
  const paths = [".git", "nested/.git", "nested/src", "git", "nested/.github"];
  const entries = paths.map((path) => ({
    path,
    kind: "directory" as const,
    size: 0,
    modifiedAt: "2026-09-08T00:00:00.000Z",
  }));
  options.workspace.list.mockResolvedValue(entries);
  const listing = createRuntimeReadTools(options).find(
    (tool) => tool.name === "marea_list_project",
  );
  expect(await listing?.execute({ path: "/" })).toBe(
    readToolPage(JSON.stringify(entries.slice(2)), 0),
  );
});
