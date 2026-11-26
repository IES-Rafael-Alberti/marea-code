/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars -- Fixture streams yield without awaiting. */
import { describe, expect, it } from "vitest";

import type { AgentApprovalTurn, AgentEvent, AgentMessageTurn } from "./contracts.js";
import { BoundedStateStore } from "./bounded-state.fixture.js";
import { LocalSession } from "./local-session.js";
import { clipStoredText, MAX_STORED_TEXT } from "./stored-limits.js";
import {
  APPROVAL_ID,
  FIXTURE_CLOCK,
  FixtureAgent,
  FixtureIds,
  createFixtureController,
} from "./student.fixture.js";

const LARGE_CONTENT = "w".repeat(200_000);

class LargeWriteAgent extends FixtureAgent {
  override async *streamMessage(
    turn: AgentMessageTurn,
    _signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.messageTurns.push(turn);
    yield { type: "assistant-text-delta", text: "t".repeat(40_000) };
    yield { type: "assistant-text-delta", text: "u".repeat(40_000) };
    yield {
      type: "write-approval-required",
      approvalId: APPROVAL_ID,
      path: "notes.txt",
      content: LARGE_CONTENT,
      summary: "Create notes.txt",
    };
  }

  override async *resumeApproval(
    turn: AgentApprovalTurn,
    _signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.approvalTurns.push(turn);
    yield { type: "turn-completed" };
  }
}

describe("bounded stored text", () => {
  it("clips a stored text to the largest event text", () => {
    expect(clipStoredText("x".repeat(MAX_STORED_TEXT))).toHaveLength(MAX_STORED_TEXT);
    expect(clipStoredText("x".repeat(MAX_STORED_TEXT + 1))).toHaveLength(MAX_STORED_TEXT);
    expect(clipStoredText("short")).toBe("short");
  });

  it("saves an oversized partial reply and an oversized final reply without failing the turn", async () => {
    const store = new BoundedStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    const opening = store.state.run;
    if (opening === null) throw new Error("Fixture run missing.");
    store.state = { ...store.state, run: { ...opening, phase: "active" } };
    await session.setTurn({ messageId: "message:one", state: "started" });

    await session.updateTurnText("message:one", "p".repeat(MAX_STORED_TEXT + 10));
    expect(store.state.run?.turns[0]?.text).toHaveLength(MAX_STORED_TEXT);

    await session.finishTurn("message:one", "completed", "a".repeat(MAX_STORED_TEXT + 10));
    expect(store.state.run?.turns[0]?.text).toHaveLength(MAX_STORED_TEXT);
    const event = store.state.run?.outbox.at(-1)?.value;
    expect(event).toMatchObject({ eventType: "assistant-message" });
    expect(event?.eventType === "assistant-message" ? event.content : "").toHaveLength(
      MAX_STORED_TEXT,
    );
  });

  it("completes a turn whose reply and write exceed 64k characters, applying the full write", async () => {
    const state = new BoundedStateStore();
    const fixture = createFixtureController({ agent: new LargeWriteAgent(), state });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage("message:big", "Write it.", new AbortController().signal);

    expect(fixture.workspace.calls).toMatchObject([{ content: LARGE_CONTENT }]);
    const events = [...fixture.server.events.values()];
    const requested = events.find((event) => event.eventType === "approval-requested");
    expect(requested).toMatchObject({ truncated: true });
    expect(requested?.eventType === "approval-requested" ? requested.content : "").toHaveLength(
      MAX_STORED_TEXT,
    );
    expect(state.state.run?.turns.find((turn) => turn.messageId === "message:big")).toMatchObject({
      state: "completed",
    });
  });
});
