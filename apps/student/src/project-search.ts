import type { ReadOnlyTool } from "@marea/deepagents-adapter";
import { WorkspaceError, type WorkspaceBackend } from "@marea/workspace-backend";
import * as z from "zod";
import { projectGlob } from "./project-glob.js";

const SearchSchema = z
  .object({ path: z.string().prefault("/"), query: z.string().min(1).max(128) })
  .strict();
const SKIP = new Set([".git", "node_modules", ".venv"]);
type Reader = Pick<WorkspaceBackend, "list" | "readText">;
interface Match {
  path: string;
  line: number;
  text: string;
}

async function* projectFiles(workspace: Reader, path: string) {
  const pending = [path];
  let visited = 0;
  for (const directory of pending) {
    for (const entry of await workspace.list(directory)) {
      if (++visited > 1000) {
        yield null;
      } else if (!SKIP.has(entry.path.substring(entry.path.lastIndexOf("/") + 1))) {
        if (entry.kind === "directory") pending.push(entry.path);
        else yield entry.path;
      }
    }
  }
}
async function matchingLines(
  workspace: Reader,
  path: string,
  query: string,
): Promise<Match[] | null> {
  try {
    const content = await workspace.readText(path);
    return content
      .split("\n")
      .flatMap((text, index) => (text.includes(query) ? [{ path, line: index + 1, text }] : []));
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      ["unsupported-text-encoding", "read-limit-exceeded"].includes(error.code)
    )
      return null;
    throw error;
  }
}
async function search(
  workspace: Reader,
  input: Readonly<Record<string, string>>,
  filesOnly: boolean,
): Promise<string> {
  const { path, query } = SearchSchema.parse(input);
  const matches: Match[] = [];
  let truncated = false;
  for await (const file of projectFiles(workspace, path)) {
    if (file === null) {
      truncated = true;
      break;
    }
    const found = filesOnly
      ? projectGlob(query, file.slice(1))
        ? [{ path: file, line: 0, text: "" }]
        : []
      : await matchingLines(workspace, file, query);
    if (found === null) {
      truncated = true;
      continue;
    }
    for (const item of found) {
      if (matches.length === 200) break;
      matches.push({ ...item, text: item.text.slice(0, 512) });
      truncated ||= item.text.length > 512;
    }
    if (matches.length === 200) {
      truncated = true;
      break;
    }
  }
  return JSON.stringify({ matches, truncated });
}
/** Guarded search with explicit entry, result and line limits. */
export function projectSearchTools(workspace: Reader): readonly ReadOnlyTool[] {
  return [
    {
      name: "marea_search_project",
      description:
        "Search literal file contents. Arguments: query, optional path (directory, default /). Returns path, line, text and truncated. Limits: 1000 entries, 200 matches, 512 characters per line.",
      execute: (input) => search(workspace, input, false),
    },
    {
      name: "marea_glob_project",
      description:
        "Find project files by glob (*, **, ?). Arguments: query, optional path (directory, default /). Patterns match project-relative paths. Limits: 1000 entries, 200 matches. Truncation is explicit.",
      execute: (input) => search(workspace, input, true),
    },
  ];
}
