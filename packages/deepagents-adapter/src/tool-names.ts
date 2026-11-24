/**
 * Marea's tools keep internal `marea_*` names in events, policy and history; the model sees the
 * standard DeepAgents names, so it never meets two tools for one job.
 */
const PUBLIC_NAMES: ReadonlyMap<string, string> = new Map([
  ["marea_write_file", "write_file"],
  ["marea_edit_file", "edit_file"],
  ["marea_execute", "execute"],
  ["marea_delete", "delete"],
  ["marea_read_project", "read_file"],
  ["marea_list_project", "ls"],
  ["marea_glob_project", "glob"],
  ["marea_search_project", "grep"],
]);

/**
 * DeepAgents' own tools. Marea implements the ones it offers under these names itself; the
 * built-ins are denied by policy, so they are never shown to the model and a call to one is
 * answered as an unknown tool.
 */
export const DEEPAGENTS_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
  "delete",
  "task",
  "write_todos",
]);

export function toPublicToolName(name: string): string {
  return PUBLIC_NAMES.get(name) ?? name;
}

export function toInternalToolName(name: string): string {
  for (const [internal, external] of PUBLIC_NAMES) if (external === name) return internal;
  return name;
}
