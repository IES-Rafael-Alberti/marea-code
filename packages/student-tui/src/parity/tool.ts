import { readableToolResult } from "./read-output.boundary.js";
import type { ToolCopy } from "./copy.js";
import { GEOMETRY } from "./tokens.js";

/**
 * How a tool call reads in the conversation.
 *
 * The row is deliberately quiet while the tool runs and stays quiet when it
 * succeeds: three trailing lines and a hint. A failure is the exception, and
 * opens itself, because that is the thing the student has to look at.
 */

/** The arguments the row is allowed to show. Anything else stays unseen. */
export interface ToolArguments {
  readonly command?: string | undefined;
  readonly description?: string | undefined;
  readonly filePath?: string | undefined;
  readonly path?: string | undefined;
  readonly pattern?: string | undefined;
  readonly query?: string | undefined;
}

export interface ToolCall {
  readonly arguments: ToolArguments;
  readonly callId: string;
  readonly name: string;
}

export interface ToolOutcome {
  readonly failed: boolean;
  readonly result: string;
}

export interface ToolRow {
  readonly call: ToolCall;
  readonly expanded: boolean;
  readonly outcome: ToolOutcome | null;
}

const LABELS = new Map<string, string>([
  ["delete", "del"],
  ["edit_file", "edit"],
  ["execute", "shell"],
  ["marea_list_project", "list"],
  ["marea_edit_file", "edit"],
  ["marea_delete", "del"],
  ["marea_execute", "shell"],
  ["marea_search_project", "grep"],
  ["marea_glob_project", "glob"],
  ["marea_read_project", "read"],
  ["marea_read_skill", "skill"],
  ["marea_write_file", "write"],
  ["read_file", "read"],
  ["write_file", "write"],
  ["write_todos", "plan"],
]);

/** Tools whose output reads as paged file content with hidden lines. */
const PAGED_READ_TOOLS: ReadonlySet<string> = new Set([
  "marea_read_project",
  "marea_read_skill",
  "read_file",
]);

/** Only the display keys survive the trip from a tool call to its row. */
const ARGUMENT_KEYS = ["command", "description", "filePath", "path", "pattern", "query"] as const;

export function filterToolArguments(args: Readonly<Record<string, string>>): ToolArguments {
  const kept: Record<string, string> = {};
  for (const key of ARGUMENT_KEYS) {
    const value = args[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/** The short name a tool is shown under, or its own name when it has none. */
export function toolLabel(
  name: string,
  labels: Readonly<{
    readonly question?: string | undefined;
    readonly subagent?: string | undefined;
  }> = {},
): string {
  if (name === "ask_user" || name === "marea_ask_user") return labels.question ?? "pregunta";
  if (name === "task") return labels.subagent ?? "subagente";
  return LABELS.get(name) ?? name;
}

/** The one-line argument summary beside the tool name. */
export function summarizeTool(call: ToolCall): string {
  const { arguments: args, name } = call;
  const value =
    name === "execute" || name === "marea_execute"
      ? (args.command ?? "")
      : (args.filePath ?? args.path ?? args.pattern ?? args.query ?? args.description ?? "");
  const characters = Array.from(value);
  if (characters.length <= GEOMETRY.toolSummaryLimit) return value;
  return `${characters.slice(0, GEOMETRY.toolSummaryLimit - 3).join("")}…`;
}

type ToolGlyph = "running" | "done" | "failed";

export interface ToolHeader {
  readonly glyph: ToolGlyph;
  readonly label: string;
  /** The `> output` or `v output` marker, absent while the tool runs. */
  readonly marker: string | null;
  readonly summary: string;
}

export function toolHeader(row: ToolRow, copy: ToolCopy): ToolHeader {
  const glyph: ToolGlyph =
    row.outcome === null ? "running" : row.outcome.failed ? "failed" : "done";
  return {
    glyph,
    label: toolLabel(row.call.name, {
      question: copy.questionLabel,
      subagent: copy.subagentLabel,
    }),
    marker: row.outcome === null ? null : `${row.expanded ? "v" : ">"} ${copy.output}`,
    summary: summarizeTool(row.call),
  };
}

/** The finished output, with an empty result named rather than left blank. */
export function toolOutput(outcome: ToolOutcome, copy: ToolCopy, name: string): string {
  return readableToolResult(name, outcome.result).trim() || copy.emptyOutput;
}

export interface ToolSummary {
  /** The dim italic footer, absent when nothing was hidden. */
  readonly hint: string | null;
  readonly lines: readonly string[];
  /** The dim header naming the hidden lines, absent when nothing was hidden. */
  readonly omitted: string | null;
}

/**
 * The compact summary of a finished tool: the last lines of its output, said
 * plainly, with a count of what is not shown. Reading a file is summarised by
 * how much was read, because its trailing lines carry no meaning on their own.
 */
export function toolSummary(row: ToolRow, copy: ToolCopy): ToolSummary | null {
  if (row.outcome === null) return null;
  const output = toolOutput(row.outcome, copy, row.call.name);
  const lines = output.split("\n");
  const visible = lines.slice(-GEOMETRY.compactOutputLines);
  const hidden = lines.length - visible.length;

  if (PAGED_READ_TOOLS.has(row.call.name) && hidden > 0) {
    return {
      hint: copy.seeContent,
      lines: [copy.linesRead(lines.length)],
      omitted: null,
    };
  }
  if (hidden === 0) return { hint: null, lines: visible, omitted: null };
  return {
    hint: copy.seeOutput,
    lines: visible,
    omitted: hidden === 1 ? copy.omittedOne : copy.omittedMany(hidden),
  };
}

/** Whether a finished row should be open, given the current output mode. */
export function toolShouldExpand(row: ToolRow, detailed: boolean): boolean {
  return row.outcome !== null && (detailed || row.outcome.failed);
}
