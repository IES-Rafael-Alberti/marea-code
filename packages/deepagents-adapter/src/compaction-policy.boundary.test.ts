import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  COMPACTION_KEEP_MESSAGES,
  COMPACTION_TRIGGER_MESSAGES,
  SUMMARY_CHARACTERS,
  SUMMARY_TRANSCRIPT_CHARACTERS,
  createCompactionMiddleware,
} from "./compaction.boundary.js";

interface Compaction {
  readonly cutoffIndex: number;
  readonly summary: string;
}

/** Synthetic turns: a student message, one tool batch of `batch` calls, and an answer. */
function history(turns: number, batch = 1, result = "ok"): BaseMessage[] {
  const messages: BaseMessage[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(new HumanMessage(`question ${String(turn)}`));
    const ids = Array.from({ length: batch }, (_, call) => `call-${String(turn)}-${String(call)}`);
    messages.push(
      new AIMessage({
        content: "",
        tool_calls: ids.map((id) => ({ id, name: "marea_read_project", args: { path: id } })),
      }),
    );
    for (const id of ids) {
      messages.push(
        new ToolMessage({ content: result, tool_call_id: id, name: "marea_read_project" }),
      );
    }
    messages.push(new AIMessage(`answer ${String(turn)}`));
  }
  return messages;
}

interface SummaryOptions {
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
}

const UpdateSchema = z.object({
  mareaCompaction: z.object({ cutoffIndex: z.number(), summary: z.string() }),
});

async function compact(
  messages: BaseMessage[],
  summary: string | AIMessage = "Synthetic summary.",
  previous?: Compaction,
) {
  const summaryInputs: BaseMessage[][] = [];
  const sentLists: BaseMessage[][] = [];
  const invoke = vi.fn((input: BaseMessage[], options: SummaryOptions) => {
    summaryInputs.push(input);
    expect(options).toEqual({ tags: ["nostream"], metadata: { lc_source: "summarization" } });
    return Promise.resolve(summary);
  });
  const handler = vi.fn((request: { readonly messages: BaseMessage[] }) => {
    sentLists.push(request.messages);
    return Promise.resolve(new AIMessage("reply"));
  });
  const wrap = createCompactionMiddleware().wrapModelCall;
  if (wrap === undefined) throw new Error("Compaction must wrap model calls.");
  const request = {
    messages,
    model: { invoke },
    state: { messages, mareaCompaction: previous },
  };
  const result = await wrap(request as never, handler as never);
  return { invoke, result, sent: sentLists[0] ?? [], summaryInput: summaryInputs[0] };
}

function update(result: object): Compaction {
  if (!(result instanceof Command)) throw new Error("Expected a compaction update.");
  return UpdateSchema.parse(result.update).mareaCompaction;
}

describe("compaction policy", () => {
  it("passes shorter conversations through untouched", async () => {
    const messages = history(1);
    while (messages.length < COMPACTION_TRIGGER_MESSAGES - 1)
      messages.push(new HumanMessage("more"));
    const { invoke, result, sent } = await compact(messages);
    expect(invoke).not.toHaveBeenCalled();
    expect(sent).toEqual(messages);
    expect(result).toBeInstanceOf(AIMessage);
  });

  it("summarizes at the trigger and keeps the recent tail verbatim", async () => {
    // 4 messages per turn: 40 turns reach the trigger exactly.
    const messages = history(COMPACTION_TRIGGER_MESSAGES / 4);
    const { invoke, result, sent, summaryInput } = await compact(messages);

    expect(invoke).toHaveBeenCalledOnce();
    const compaction = update(result);
    expect(compaction).toEqual({
      cutoffIndex: COMPACTION_TRIGGER_MESSAGES - COMPACTION_KEEP_MESSAGES,
      summary: "Synthetic summary.",
    });
    expect(sent).toHaveLength(COMPACTION_KEEP_MESSAGES + 1);
    expect(sent[0]?.text).toMatch(
      /^Summary of the earlier part of this session\.[^]*Synthetic summary\.$/u,
    );
    expect(sent.slice(1)).toEqual(messages.slice(compaction.cutoffIndex));
    expect(HumanMessage.isInstance(sent[1])).toBe(true);
    expect(summaryInput?.map((message) => message.type)).toEqual(["system", "human"]);
    expect(summaryInput?.[1]?.text).toBe(
      messages
        .slice(0, compaction.cutoffIndex)
        .map((message) =>
          HumanMessage.isInstance(message)
            ? `Student: ${message.text}`
            : ToolMessage.isInstance(message)
              ? `Tool result (marea_read_project): ${message.text}`
              : message.text === ""
                ? `Tutor: [tool call marea_read_project {"path":"${String((message as AIMessage).tool_calls?.[0]?.id)}"}]`
                : `Tutor: ${message.text}`,
        )
        .join("\n\n"),
    );
  });

  it("reuses an earlier summary and folds it into the next one", async () => {
    const messages = history(60);
    const previous = { cutoffIndex: 100, summary: "Earlier synthetic summary." };
    const { result, sent, summaryInput } = await compact(messages, "Newer summary.", previous);

    // 1 summary + 140 kept messages = 141 effective messages: still below the trigger.
    expect(sent).toHaveLength(141);
    expect(sent[0]?.text).toContain("Earlier synthetic summary.");
    expect(sent.slice(1)).toEqual(messages.slice(100));
    expect(summaryInput).toBeUndefined();
    expect(result).toBeInstanceOf(AIMessage);

    const longer = history(70);
    const next = await compact(longer, "Newer summary.", previous);
    const compaction = update(next.result);
    expect(next.summaryInput?.[1]?.text).toMatch(
      /^Student: Summary of the earlier part[^]*Earlier synthetic summary\./u,
    );
    // Effective list: summary + 180 state messages from index 100; keep its last 40.
    expect(compaction.cutoffIndex).toBe(100 - 1 + 181 - COMPACTION_KEEP_MESSAGES);
    expect(next.sent.slice(1)).toEqual(longer.slice(compaction.cutoffIndex));
  });

  it("describes messages that carry no tool metadata", async () => {
    const bare = new AIMessage("plain answer");
    Reflect.deleteProperty(bare, "tool_calls");
    const anonymous = new ToolMessage({ content: "anonymous result", tool_call_id: "anon" });
    const messages = [bare, anonymous, ...history(COMPACTION_TRIGGER_MESSAGES / 4)];
    const { summaryInput } = await compact(messages);
    expect(summaryInput?.[1]?.text).toMatch(
      /^Tutor: plain answer\n\nTool result \(tool\): anonymous result\n\nStudent: question 0/u,
    );
  });

  it("ignores a stale cutoff beyond the current history", async () => {
    const messages = history(2);
    const { sent } = await compact(messages, "unused", { cutoffIndex: 99, summary: "stale" });
    expect(sent).toEqual(messages);
  });

  it("applies a summary that covers the whole stored history", async () => {
    const messages = history(2);
    const { sent } = await compact(messages, "unused", { cutoffIndex: 8, summary: "all" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/all$/u);
  });

  it("keeps a whole large tool batch with its assistant call", async () => {
    const messages = [...history(30), ...history(1, 60)];
    const { result, sent } = await compact(messages);
    const compaction = update(result);
    expect(compaction.cutoffIndex).toBe(120 + 1);
    expect(sent).toHaveLength(1 + 62);
    expect(AIMessage.isInstance(sent[1])).toBe(true);
  });

  it("bounds the transcript, shortening only the longest entries", async () => {
    const messages = history(COMPACTION_TRIGGER_MESSAGES / 4, 1, "y".repeat(10_000));
    const { summaryInput } = await compact(messages);
    const transcript = summaryInput?.[1]?.text ?? "";
    expect(transcript.length).toBeLessThanOrEqual(SUMMARY_TRANSCRIPT_CHARACTERS);
    expect(transcript.length).toBeGreaterThan(SUMMARY_TRANSCRIPT_CHARACTERS - 120 * 64);
    expect(transcript).toContain("Student: question 0\n\n");
    expect(transcript).toMatch(/y\n\[… \d+ characters omitted …\]/u);
  });

  it("accepts plain-text model output and clips an oversized summary", async () => {
    const messages = history(COMPACTION_TRIGGER_MESSAGES / 4);
    const long = "s".repeat(SUMMARY_CHARACTERS + 5);
    const { result } = await compact(messages, `  ${long}  `);
    expect(update(result).summary).toBe(
      `${"s".repeat(SUMMARY_CHARACTERS)}\n[… 5 characters omitted …]`,
    );

    const exact = await compact(messages, new AIMessage("s".repeat(SUMMARY_CHARACTERS)));
    expect(update(exact.result).summary).toBe("s".repeat(SUMMARY_CHARACTERS));
  });

  it("refuses an empty summary with a retryable typed failure", async () => {
    await expect(
      compact(history(COMPACTION_TRIGGER_MESSAGES / 4), new AIMessage("  ")),
    ).rejects.toMatchObject({
      name: "ModelStreamError",
      streamCode: "invalid-response",
      streamRetryable: true,
      streamMessage: "The model returned an empty summary while compacting the session. Try again.",
    });
  });

  it("gives entries left after an exact fair share the remaining budget", async () => {
    // 120 summarized entries leave 60,000 - 120 * 64 = 52,320 characters. After 118 short
    // entries (1,181 characters) 51,139 remain: the 25,569-character entry fits its exact
    // share, so the longest entry may use the other 25,570.
    const short = Array.from(
      { length: 118 },
      (_, index) => new HumanMessage(index === 0 ? "qq" : "q"),
    );
    const messages = [
      ...short,
      new HumanMessage("x".repeat(25_560)),
      new HumanMessage("y".repeat(39_991)),
      ...Array.from({ length: COMPACTION_KEEP_MESSAGES }, () => new HumanMessage("kept")),
    ];
    const { summaryInput } = await compact(messages);
    const transcript = summaryInput?.[1]?.text ?? "";
    expect(transcript).toContain(`Student: ${"x".repeat(25_560)}\n\n`);
    expect(transcript).toContain(`Student: ${"y".repeat(25_561)}\n[… 14430 characters omitted …]`);
  });
});
