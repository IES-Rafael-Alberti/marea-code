import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import * as z from "zod";

import { ModelStreamError } from "./contracts.js";

/**
 * The model gateway accepts at most 256 messages per request, the system prompt included.
 * Compaction starts well before that wall so one model step (an assistant message plus at
 * most 64 tool results) can never push a request over it.
 */
export const COMPACTION_TRIGGER_MESSAGES = 160;
/** Recent messages kept verbatim after compaction; the rest becomes one summary. */
export const COMPACTION_KEEP_MESSAGES = 40;
/** The summary request carries the transcript as one gateway message (65,536 characters). */
export const SUMMARY_TRANSCRIPT_CHARACTERS = 60_000;
/** A summary longer than this is clipped, with a notice, before it enters the prompt. */
export const SUMMARY_CHARACTERS = 16_000;
const OMISSION_RESERVE = 64;

const SUMMARY_INSTRUCTIONS =
  "You compact an earlier part of a tutoring session between a student and Marea, a programming tutor. Write a faithful summary that lets the tutor continue without the original messages: the student's goals and questions, what was explained, decisions taken, files and commands involved with their relevant results, errors still open and the next pending step. Keep the language the student uses. Do not invent facts and do not address the student. Answer with the summary only.";
const SUMMARY_PREFIX =
  "Summary of the earlier part of this session. Marea compacted older messages to stay within the model gateway limits; the most recent messages follow verbatim.\n\n";

const CompactionSchema = z.object({
  cutoffIndex: z.number().int().positive(),
  summary: z.string().min(1),
});
type Compaction = z.infer<typeof CompactionSchema>;

/**
 * Replaces DeepAgents' token-based summarization (same middleware name, same stack slot).
 * The durable message history is never rewritten: the summary and its cutoff live in a
 * separate state channel, so recovery and approvals keep reading the full transcript.
 */
export function createCompactionMiddleware() {
  return createMiddleware({
    name: "SummarizationMiddleware",
    stateSchema: z.object({ mareaCompaction: CompactionSchema.optional() }),
    wrapModelCall: async (request, handler) => {
      const previous = request.state.mareaCompaction;
      const effective = effectiveMessages(request.messages, previous);
      if (effective.messages.length < COMPACTION_TRIGGER_MESSAGES) {
        return handler({ ...request, messages: effective.messages });
      }
      const start = keptStart(effective.messages);
      const response = await request.model.invoke(
        [
          new SystemMessage(SUMMARY_INSTRUCTIONS),
          new HumanMessage(transcript(effective.messages.slice(0, start))),
        ],
        // Internal call: its tokens must never reach the student's stream or journal.
        { tags: ["nostream"], metadata: { lc_source: "summarization" } },
      );
      const compaction: Compaction = {
        cutoffIndex: effective.offset + start,
        summary: summaryText(typeof response === "string" ? response : response.text),
      };
      await handler({
        ...request,
        messages: [summaryMessage(compaction.summary), ...effective.messages.slice(start)],
      });
      return new Command({ update: { mareaCompaction: compaction } });
    },
  });
}

interface EffectiveMessages {
  readonly messages: BaseMessage[];
  /** State index of `messages[1]` when a summary leads, of `messages[0]` otherwise. */
  readonly offset: number;
}

function effectiveMessages(
  messages: BaseMessage[],
  previous: Compaction | undefined,
): EffectiveMessages {
  if (previous === undefined || previous.cutoffIndex > messages.length) {
    return { messages, offset: 0 };
  }
  return {
    messages: [summaryMessage(previous.summary), ...messages.slice(previous.cutoffIndex)],
    offset: previous.cutoffIndex - 1,
  };
}

/** Never start the kept tail inside a tool batch: an AI tool call keeps all its results. */
function keptStart(messages: readonly BaseMessage[]): number {
  let start = messages.length - COMPACTION_KEEP_MESSAGES;
  while (ToolMessage.isInstance(messages[start])) start -= 1;
  return start;
}

function summaryMessage(summary: string): HumanMessage {
  return new HumanMessage({ content: SUMMARY_PREFIX + summary });
}

function summaryText(text: string): string {
  const summary = text.trim();
  if (summary.length === 0) {
    throw new ModelStreamError({
      code: "invalid-response",
      message: "The model returned an empty summary while compacting the session. Try again.",
      retryable: true,
    });
  }
  return clip(summary, SUMMARY_CHARACTERS);
}

function transcript(messages: readonly BaseMessage[]): string {
  const entries = messages.map(entry);
  const cap = fairShare(
    entries.map((text) => text.length),
    SUMMARY_TRANSCRIPT_CHARACTERS - entries.length * OMISSION_RESERVE,
  );
  return entries.map((text) => clip(text, cap)).join("\n\n");
}

function entry(message: BaseMessage): string {
  if (AIMessage.isInstance(message)) {
    const calls = (message.tool_calls ?? []).map(
      (call) => `[tool call ${call.name} ${JSON.stringify(call.args)}]`,
    );
    return ["Tutor:", message.text, ...calls].filter((part) => part.length > 0).join(" ");
  }
  if (ToolMessage.isInstance(message))
    return `Tool result (${message.name ?? "tool"}): ${message.text}`;
  return `Student: ${message.text}`;
}

/** Largest per-entry length that fits the budget, shortening only the longest entries. */
function fairShare(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((left, right) => left - right);
  let remaining = budget;
  for (const [index, length] of sorted.entries()) {
    const share = Math.floor(remaining / (sorted.length - index));
    if (length > share) return share;
    remaining -= length;
  }
  return Number.POSITIVE_INFINITY;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${String(text.length - limit)} characters omitted …]`;
}
