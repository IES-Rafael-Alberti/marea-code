import { describe, expect, it } from "vitest";

import type { ParityEvent, SessionContext } from "./events.js";
import {
  applyApproval,
  applyEvent,
  applyQuestions,
  openSession,
  type SessionState,
} from "./session-state.js";

const CONTEXT: SessionContext = {
  branch: "main",
  cwd: "/proyecto",
  model: "modelo-docente",
  repositoryUrl: "",
};

const STARTED: ParityEvent = { context: CONTEXT, type: "session-started" };

function feed(state: SessionState, ...events: readonly ParityEvent[]): SessionState {
  return events.reduce(applyEvent, state);
}

function kinds(state: SessionState): readonly string[] {
  return state.transcript.map((entry) => entry.kind);
}

describe("session start", () => {
  it("waits with the composer closed until the session starts", () => {
    const state = openSession();
    expect(state).toMatchObject({
      detailedOutputs: false,
      fatal: false,
      notification: null,
      pendingId: null,
      starting: true,
      transcript: [],
      turnActive: true,
    });
    expect(state.history).toEqual({ draft: "", entries: [], index: -1 });
    expect(state.status).toMatchObject({ activity: "starting", elapsedMs: 0, hint: "turn" });
  });

  it("takes the history it is given", () => {
    expect(openSession(["hola"]).history.entries).toEqual(["hola"]);
  });

  it("shows the banner and takes the context into the status bar", () => {
    const state = applyEvent(openSession(), STARTED);
    expect(state.starting).toBe(false);
    expect(state.transcript).toEqual([{ context: CONTEXT, id: "e0", kind: "banner" }]);
    expect(state.status).toEqual({
      activity: "reviewing",
      branch: "main",
      elapsedMs: 0,
      hint: "turn",
      model: "modelo-docente",
      toolName: "",
    });
  });
});

describe("assistant text", () => {
  it("collects text into one entry while it answers", () => {
    const state = feed(
      openSession(),
      STARTED,
      { text: "Hola", type: "assistant-text" },
      { text: " mundo", type: "assistant-text" },
    );
    expect(kinds(state)).toEqual(["banner", "assistant"]);
    expect(state.transcript.at(-1)).toEqual({
      id: "e1",
      kind: "assistant",
      streaming: true,
      text: "Hola mundo",
    });
    expect(state.nextId).toBe(2);
    expect(state.status.activity).toBe("responding");
  });

  it("settles the text and finishes when the turn ends", () => {
    const state = feed(
      openSession(),
      { text: "Hola", type: "assistant-text" },
      { type: "turn-finished" },
    );
    expect(state.transcript.at(-1)).toMatchObject({ streaming: false });
    expect(state.status.activity).toBe("finishing");
  });

  it("settles the text before a reasoning note and keeps numbering entries", () => {
    const state = feed(
      openSession(),
      { text: "Hola", type: "assistant-text" },
      { text: "voy a mirar el fichero", type: "reasoning" },
    );
    expect(kinds(state)).toEqual(["assistant", "reasoning"]);
    expect(state.transcript.map((entry) => entry.id)).toEqual(["e0", "e1"]);
    expect(state.status.activity).toBe("thinking");
  });
});

describe("tools", () => {
  const start: ParityEvent = {
    arguments: { command: "pytest -q" },
    callId: "c1",
    name: "execute",
    type: "tool-started",
  };

  it("shows the running tool under its own name, closed and unfinished", () => {
    const state = feed(openSession(), { text: "Voy", type: "assistant-text" }, start);
    expect(kinds(state)).toEqual(["assistant", "tool"]);
    expect(state.transcript[1]).toEqual({
      id: "e1",
      kind: "tool",
      row: {
        call: { arguments: { command: "pytest -q" }, callId: "c1", name: "execute" },
        expanded: false,
        outcome: null,
      },
    });
    expect(state.status).toMatchObject({ activity: "tool", toolName: "execute" });
  });

  it("records the result and goes back to thinking", () => {
    const state = feed(openSession(), start, {
      callId: "c1",
      failed: false,
      result: "8 passed",
      type: "tool-finished",
    });
    expect(state.transcript[0]).toMatchObject({ row: { expanded: false } });
    expect(state.status.activity).toBe("thinking");
  });

  it("opens a failure without being asked", () => {
    const state = feed(openSession(), start, {
      callId: "c1",
      failed: true,
      result: "boom",
      type: "tool-finished",
    });
    expect(state.transcript[0]).toMatchObject({ row: { expanded: true } });
  });

  it("opens every result while outputs are detailed", () => {
    const detailed = { ...openSession(), detailedOutputs: true };
    const state = feed(detailed, start, {
      callId: "c1",
      failed: false,
      result: "ok",
      type: "tool-finished",
    });
    expect(state.transcript[0]).toMatchObject({ row: { expanded: true } });
  });
});

describe("failures", () => {
  it("offers a retry when a checkpoint exists, and stops the clock", () => {
    const state = applyEvent(openSession(), {
      detail: "Puedes reanudar el turno.",
      message: "El proveedor ha interrumpido la respuesta.",
      recoverable: true,
      retryable: true,
      type: "turn-failed",
    });
    expect(state.transcript.at(-1)).toMatchObject({ kind: "error", retryOffered: true });
    expect(state.fatal).toBe(false);
  });

  it("takes back an earlier offer so the same checkpoint is not resumed twice", () => {
    const failure: ParityEvent = {
      detail: "",
      message: "falló",
      recoverable: true,
      retryable: true,
      type: "turn-failed",
    };
    const state = feed(openSession(), failure, failure);
    expect(state.transcript[0]).toMatchObject({ retryOffered: false, retryable: true });
    expect(state.transcript[1]).toMatchObject({ retryOffered: true });
  });

  it("marks the session unusable when the failure is not recoverable", () => {
    const state = applyEvent(openSession(), {
      detail: "",
      message: "se acabó",
      recoverable: false,
      retryable: false,
      type: "turn-failed",
    });
    expect(state.fatal).toBe(true);
    expect(state.transcript.at(-1)).toMatchObject({ retryOffered: false });
  });

  it("settles any streaming text before the error", () => {
    const state = feed(
      openSession(),
      { text: "a medias", type: "assistant-text" },
      {
        detail: "",
        message: "falló",
        recoverable: true,
        retryable: false,
        type: "turn-failed",
      },
    );
    expect(state.transcript[0]).toMatchObject({ kind: "assistant", streaming: false });
  });
});

describe("approvals", () => {
  const request = {
    arguments: { content: "x", filePath: "a.py" },
    interruptId: "i1",
    name: "write_file",
    preview: "a.py",
    warnings: [] as readonly string[],
  };
  const asked: ParityEvent = { request, type: "approval-requested" };

  function pending(): SessionState {
    return feed(openSession(), STARTED, asked);
  }

  it("holds the turn and points the hints at the decision", () => {
    const state = pending();
    expect(kinds(state)).toEqual(["banner", "approval"]);
    expect(state.pendingId).toBe("e1");
    expect(state.status).toMatchObject({
      activity: "waitingApproval",
      elapsedMs: null,
      hint: "approval",
    });
  });

  it("hands back an authorization and releases the turn", () => {
    const step = applyApproval(pending(), { type: "approve" });
    expect(step?.decision).toEqual({ interruptId: "i1", type: "approve" });
    expect(step?.state.pendingId).toBeNull();
    expect(kinds(step?.state ?? pending())).toEqual(["banner", "approval"]);
    expect(step?.state.status).toMatchObject({ activity: "thinking", hint: "turn" });
  });

  it("hands back a rejection with its reason", () => {
    const opened = applyApproval(pending(), { type: "start-reject" });
    expect(opened?.decision).toBeNull();
    const typed = applyApproval(opened?.state ?? pending(), {
      reason: "lo hago yo",
      type: "set-reason",
    });
    const rejected = applyApproval(typed?.state ?? pending(), { type: "confirm-reject" });
    expect(rejected?.decision).toEqual({
      interruptId: "i1",
      reason: "lo hago yo",
      type: "reject",
    });
  });

  it("cancels without approving", () => {
    expect(applyApproval(pending(), { type: "cancel" })?.decision).toEqual({ type: "cancel" });
  });

  it("keeps the panel on screen while the preview is opened", () => {
    const step = applyApproval(pending(), { type: "toggle-preview" });
    expect(step?.decision).toBeNull();
    expect(step?.state.pendingId).toBe("e1");
  });

  it("ignores an action when nothing is pending, or when the pending thing is not an approval", () => {
    expect(applyApproval(openSession(), { type: "approve" })).toBeNull();
    const questions = feed(openSession(), {
      request: { interruptId: "i2", questions: [] },
      type: "questions-asked",
    });
    expect(applyApproval(questions, { type: "approve" })).toBeNull();
  });

  it("ignores an action that changes nothing", () => {
    expect(applyApproval(pending(), { reason: "", type: "set-reason" })).toBeNull();
    const approved = applyApproval(pending(), { type: "approve" });
    expect(applyApproval(approved?.state ?? pending(), { type: "approve" })).toBeNull();
  });
});

describe("questions", () => {
  const request = {
    interruptId: "i2",
    questions: [{ choices: ["a", "b"], required: true, text: "¿cuál?" }],
  };
  const asked: ParityEvent = { request, type: "questions-asked" };

  function pending(): SessionState {
    return feed(openSession(), STARTED, asked);
  }

  it("holds the turn and points the hints at the answer", () => {
    const state = pending();
    expect(state.pendingId).toBe("e1");
    expect(state.status).toMatchObject({
      activity: "waitingAnswer",
      elapsedMs: null,
      hint: "questions",
    });
  });

  it("hands back the answers and releases the turn", () => {
    const typed = applyQuestions(pending(), { type: "type", value: "2" });
    expect(typed?.decision).toBeNull();
    const sent = applyQuestions(typed?.state ?? pending(), { type: "submit" });
    expect(sent?.decision).toEqual({ interruptId: "i2", type: "answers", values: ["b"] });
    expect(sent?.state.pendingId).toBeNull();
    expect(kinds(sent?.state ?? pending())).toEqual(["banner", "questions"]);
  });

  it("keeps the panel while a required answer is missing", () => {
    const step = applyQuestions(pending(), { type: "submit" });
    expect(step?.decision).toBeNull();
    expect(step?.state.pendingId).toBe("e1");
  });

  it("cancels", () => {
    expect(applyQuestions(pending(), { type: "cancel" })?.decision).toEqual({ type: "cancel" });
  });

  it("ignores an action when the pending thing is not a question set", () => {
    expect(applyQuestions(openSession(), { type: "submit" })).toBeNull();
    const approval = feed(openSession(), {
      request: {
        arguments: {},
        interruptId: "i1",
        name: "execute",
        preview: "x",
        warnings: [],
      },
      type: "approval-requested",
    });
    expect(applyQuestions(approval, { type: "submit" })).toBeNull();
  });

  it("ignores an action that changes nothing", () => {
    expect(applyQuestions(pending(), { type: "previous" })).toBeNull();
    expect(applyQuestions(pending(), { type: "type", value: "" })).toBeNull();
  });
});
