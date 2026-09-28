import { describe, expect, it } from "vitest";

import {
  appendAssistantText,
  finishAssistantText,
  finishedTools,
  finishTool,
  openAssistant,
  toggleTool,
  withdrawRetryOffers,
  type Transcript,
} from "./transcript.js";

function tool(id: string, callId: string, finished: boolean, failed = false): Transcript[number] {
  return {
    id,
    kind: "tool",
    row: {
      call: { arguments: {}, callId, name: "execute" },
      expanded: false,
      outcome: finished ? { failed, result: "ok" } : null,
    },
  };
}

describe("assistant text", () => {
  it("starts an entry and keeps appending to it", () => {
    const first = appendAssistantText([], "e0", "Hola");
    expect(first).toEqual([{ id: "e0", kind: "assistant", streaming: true, text: "Hola" }]);
    const second = appendAssistantText(first, "e1", " mundo");
    expect(second).toHaveLength(1);
    expect(openAssistant(second)?.text).toBe("Hola mundo");
  });

  it("starts a new entry once the previous one settled", () => {
    const settled = finishAssistantText(appendAssistantText([], "e0", "uno"));
    expect(openAssistant(settled)).toBeNull();
    expect(appendAssistantText(settled, "e1", "dos")).toHaveLength(2);
  });

  it("does not reopen an entry that something else followed", () => {
    const after: Transcript = [
      ...appendAssistantText([], "e0", "uno"),
      { id: "e1", kind: "reasoning", text: "pensando" },
    ];
    expect(openAssistant(after)).toBeNull();
    expect(appendAssistantText(after, "e2", "dos")).toHaveLength(3);
  });

  it("settles nothing when no entry is open", () => {
    const transcript: Transcript = [{ id: "e0", kind: "user", text: "hola" }];
    expect(finishAssistantText(transcript)).toBe(transcript);
    expect(finishAssistantText([])).toEqual([]);
  });
});

describe("tool rows", () => {
  it("records a result on the matching call only", () => {
    const transcript = [tool("e0", "c1", false), tool("e1", "c2", false)];
    const finished = finishTool(transcript, "c1", { failed: false, result: "8 passed" }, false);
    expect(finished[0]).toMatchObject({ row: { expanded: false } });
    expect(finished[1]).toBe(transcript[1]);
  });

  it("opens a finished tool when outputs are detailed, and always on a failure", () => {
    const transcript = [tool("e0", "c1", false)];
    expect(finishTool(transcript, "c1", { failed: false, result: "ok" }, true)[0]).toMatchObject({
      row: { expanded: true },
    });
    expect(finishTool(transcript, "c1", { failed: true, result: "boom" }, false)[0]).toMatchObject({
      row: { expanded: true },
    });
  });

  it("leaves everything alone when no call matches", () => {
    const transcript: Transcript = [
      tool("e0", "c1", false),
      { id: "e1", kind: "user", text: "hola" },
    ];
    const untouched = finishTool(transcript, "c9", { failed: false, result: "ok" }, false);
    expect(untouched[0]).toBe(transcript[0]);
    expect(untouched[1]).toBe(transcript[1]);
  });

  it("toggles only a finished row, and only the one asked for", () => {
    const transcript: Transcript = [
      tool("e0", "c1", true),
      tool("e1", "c2", false),
      { id: "e2", kind: "user", text: "hola" },
    ];
    const opened = toggleTool(transcript, "e0", true);
    expect(opened[0]).toMatchObject({ row: { expanded: true } });
    expect(toggleTool(transcript, "e1", true)[1]).toBe(transcript[1]);
    expect(toggleTool(transcript, "e9", true)[0]).toBe(transcript[0]);
    expect(toggleTool(transcript, "e2", true)[2]).toBe(transcript[2]);
  });

  it("lists the finished rows", () => {
    const transcript = [
      tool("e0", "c1", true),
      { id: "e1", kind: "user", text: "hola" } as const,
      tool("e2", "c2", false),
      tool("e3", "c3", true, true),
    ];
    expect(finishedTools(transcript).map((entry) => entry.id)).toEqual(["e0", "e3"]);
  });
});

describe("retry offers", () => {
  it("withdraws a live offer and leaves a spent one alone", () => {
    const transcript: Transcript = [
      { detail: "", id: "e0", kind: "error", message: "a", retryOffered: false, retryable: true },
      { detail: "", id: "e1", kind: "error", message: "b", retryOffered: true, retryable: true },
      { id: "e2", kind: "user", text: "hola" },
    ];
    const withdrawn = withdrawRetryOffers(transcript);
    expect(withdrawn[0]).toEqual(transcript[0]);
    expect(withdrawn[1]).toEqual({ ...transcript[1], retryOffered: false });
    expect(withdrawn[2]).toBe(transcript[2]);
  });
});
