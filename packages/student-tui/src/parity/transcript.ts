import type { ApprovalState } from "./approval.js";
import type { SessionContext } from "./events.js";
import type { QuestionsState } from "./questions.js";
import type { ToolOutcome, ToolRow } from "./tool.js";

/**
 * The conversation as a list of things that happened.
 *
 * Entries are never rewritten in place by anything but their own update: a
 * resolved approval stays on screen with its outcome, a finished tool keeps its
 * row. That is what lets a student scroll back and see what they decided.
 */

interface BannerEntry {
  readonly context: SessionContext;
  readonly id: string;
  readonly kind: "banner";
}

interface UserEntry {
  readonly id: string;
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantEntry {
  readonly id: string;
  readonly kind: "assistant";
  /** True while more text may still arrive, which keeps Markdown streaming. */
  readonly streaming: boolean;
  readonly text: string;
}

interface ReasoningEntry {
  readonly id: string;
  readonly kind: "reasoning";
  readonly text: string;
}

export interface ToolEntry {
  readonly id: string;
  readonly kind: "tool";
  readonly row: ToolRow;
}

interface ApprovalEntry {
  readonly approval: ApprovalState;
  readonly id: string;
  readonly kind: "approval";
}

interface QuestionsEntry {
  readonly id: string;
  readonly kind: "questions";
  readonly questions: QuestionsState;
}

interface ErrorEntry {
  readonly detail: string;
  readonly id: string;
  readonly kind: "error";
  readonly message: string;
  /** Whether the offer is still live; a used or superseded one is disabled. */
  readonly retryOffered: boolean;
  readonly retryable: boolean;
}

/** A short dim line: an interrupted turn, a retry starting, the help. */
interface NoticeEntry {
  readonly id: string;
  readonly kind: "notice";
  readonly text: string;
  readonly tone: "plain" | "help";
}

export type TranscriptEntry =
  | ApprovalEntry
  | AssistantEntry
  | BannerEntry
  | ErrorEntry
  | NoticeEntry
  | QuestionsEntry
  | ReasoningEntry
  | ToolEntry
  | UserEntry;

export type Transcript = readonly TranscriptEntry[];

/** The entry text is still streaming into, or null when none is open. */
export function openAssistant(transcript: Transcript): AssistantEntry | null {
  const last = transcript.at(-1);
  return last?.kind === "assistant" && last.streaming ? last : null;
}

/** Appends text to the streaming assistant entry, or starts one. */
export function appendAssistantText(transcript: Transcript, id: string, text: string): Transcript {
  const open = openAssistant(transcript);
  if (open === null) return [...transcript, { id, kind: "assistant", streaming: true, text }];
  return [...transcript.slice(0, -1), { ...open, text: open.text + text }];
}

/** Closes the streaming assistant entry so its Markdown settles. */
export function finishAssistantText(transcript: Transcript): Transcript {
  const open = openAssistant(transcript);
  if (open === null) return transcript;
  return [...transcript.slice(0, -1), { ...open, streaming: false }];
}

/** Records the result of a tool that is already on screen. */
export function finishTool(
  transcript: Transcript,
  callId: string,
  outcome: ToolOutcome,
  detailed: boolean,
): Transcript {
  return transcript.map((entry) =>
    entry.kind === "tool" && entry.row.call.callId === callId
      ? { ...entry, row: { ...entry.row, expanded: detailed || outcome.failed, outcome } }
      : entry,
  );
}

/** Opens or closes one tool row. A row that has not finished cannot open. */
export function toggleTool(transcript: Transcript, id: string, expanded: boolean): Transcript {
  return transcript.map((entry) =>
    entry.kind === "tool" && entry.id === id && entry.row.outcome !== null
      ? { ...entry, row: { ...entry.row, expanded } }
      : entry,
  );
}

/** Every finished tool row, oldest first. */
export function finishedTools(transcript: Transcript): readonly ToolEntry[] {
  return transcript.filter(
    (entry): entry is ToolEntry => entry.kind === "tool" && entry.row.outcome !== null,
  );
}

/** Takes back every retry offer so the same checkpoint is not resumed twice. */
export function withdrawRetryOffers(transcript: Transcript): Transcript {
  return transcript.map((entry) =>
    entry.kind === "error" ? { ...entry, retryOffered: false } : entry,
  );
}
