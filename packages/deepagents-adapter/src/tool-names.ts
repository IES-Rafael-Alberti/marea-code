/**
 * Marea's tools keep internal `marea_*` names in events, policy and history; the model sees the
 * standard DeepAgents names, so it never meets two tools for one job.
 */
const PUBLIC_NAMES: ReadonlyMap<string, string> = new Map([
  ["marea_write_file", "write_file"],
  ["marea_edit_file", "edit_file"],
  ["marea_execute", "execute"],
  ["marea_delete", "delete"],
]);
const INTERNAL_NAMES: ReadonlyMap<string, string> = new Map(
  [...PUBLIC_NAMES].map(([internal, external]) => [external, internal]),
);

export function toPublicToolName(name: string): string {
  return PUBLIC_NAMES.get(name) ?? name;
}

export function toInternalToolName(name: string): string {
  return INTERNAL_NAMES.get(name) ?? name;
}
