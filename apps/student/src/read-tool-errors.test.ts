import { ReadOnlyToolInputError, type ReadOnlyTool } from "@marea/deepagents-adapter";
import { WorkspaceError } from "@marea/workspace-backend";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { withCorrectableErrors } from "./read-tool-errors.js";

function failing(error: Error): ReadOnlyTool {
  return withCorrectableErrors({
    name: "marea_search_project",
    description: "Search.",
    execute: vi.fn<ReadOnlyTool["execute"]>().mockRejectedValue(error),
  });
}

describe("correctable read-tool errors", () => {
  it.each([
    "invalid-path",
    "not-found",
    "not-directory",
    "not-regular-file",
    "unsafe-entry",
    "read-limit-exceeded",
    "directory-limit-exceeded",
    "unsupported-text-encoding",
  ] as const)("returns %s to the model with the requested path", async (code) => {
    const error = new WorkspaceError(code, "read");
    const result = failing(error).execute({ path: "/missing", query: "x" });
    await expect(result).rejects.toBeInstanceOf(ReadOnlyToolInputError);
    await expect(result).rejects.toThrow(`${error.message} (/missing)`);
  });

  it("omits the path when the call named none", async () => {
    await expect(
      failing(new WorkspaceError("not-found", "read")).execute({ query: "x" }),
    ).rejects.toThrow(/^The workspace entry does not exist\.$/u);
  });

  it("explains invalid arguments by parameter", async () => {
    const parsed = z.object({ query: z.string() }).strict().safeParse({ pattern: "x" });
    if (parsed.success) throw new Error("expected invalid input");
    const result = failing(parsed.error).execute({ pattern: "x" });
    await expect(result).rejects.toBeInstanceOf(ReadOnlyToolInputError);
    await expect(result).rejects.toThrow(
      /^Invalid arguments \(query: .+; .+\)\. Check the parameters in the tool description\.$/u,
    );
    const nested = z.object({ range: z.object({ end: z.string() }) }).safeParse({ range: {} });
    if (nested.success) throw new Error("expected invalid input");
    await expect(failing(nested.error).execute({})).rejects.toThrow(
      /^Invalid arguments \(range\.end: /u,
    );
    const root = z.string().safeParse(1);
    if (root.success) throw new Error("expected invalid input");
    await expect(failing(root.error).execute({})).rejects.toThrow(
      /^Invalid arguments \(Invalid input/u,
    );
  });

  it("keeps filesystem failures and other errors fatal", async () => {
    const filesystem = new WorkspaceError("filesystem-failure", "read");
    await expect(failing(filesystem).execute({ path: "/a" })).rejects.toBe(filesystem);
    const other = new TypeError("bug");
    await expect(failing(other).execute({ path: "/a" })).rejects.toBe(other);
  });

  it("returns successful results unchanged and keeps the tool identity", async () => {
    const tool = withCorrectableErrors({
      name: "marea_glob_project",
      description: "Glob.",
      execute: () => Promise.resolve("a.ts"),
    });
    expect(tool).toMatchObject({ name: "marea_glob_project", description: "Glob." });
    await expect(tool.execute({ query: "*.ts" })).resolves.toBe("a.ts");
  });
});
