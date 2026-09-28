import { ModelStreamError } from "@marea/deepagents-adapter";
import type { OpenRunRequest, OpenRunResponse, SessionToken } from "@marea/protocol";

import type { AgentEvent, AgentMessageTurn } from "./contracts.js";
import { FixtureAgent, FixtureServer } from "./student.fixture.js";
import { DIGEST, snapshot } from "./student-snapshot.fixture.js";

const STARTUP_SNAPSHOT = {
  ...snapshot,
  startup: {
    version: "startup:1",
    digest: DIGEST,
    content: "Read the project and propose one exercise.",
  },
};

export class StartupFixtureServer extends FixtureServer {
  free = false;

  override async openRun(token: SessionToken, request: OpenRunRequest): Promise<OpenRunResponse> {
    const opened = await super.openRun(token, request);
    if (this.free) return { ...opened, snapshot: { ...snapshot, agentMode: "free" } };
    const last = [...this.events.values()].findLast((event) => event.eventType === "tutor-startup");
    return { ...opened, snapshot: STARTUP_SNAPSHOT, startupState: last?.state ?? "pending" };
  }
}

export class StartupFixtureAgent extends FixtureAgent {
  readonly startups: Omit<AgentMessageTurn, "text">[] = [];
  fail = false;
  write = false;
  cancelStartup = false;
  beforeFinish: () => void = () => undefined;
  beforeStream: (signal: AbortSignal) => Promise<void> = () => Promise.resolve();

  async *streamStartup(
    turn: Omit<AgentMessageTurn, "text">,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    await this.beforeStream(signal);
    await Promise.resolve();
    this.startups.push(turn);
    if (this.write) {
      yield* super.streamMessage({ ...turn, text: "" }, new AbortController().signal);
      return;
    }
    const content = this.fail ? "Read-only " : "Read-only introduction.";
    yield { type: "assistant-text-delta", text: content.slice(turn.assistantText?.length ?? 0) };
    if (this.fail)
      throw new ModelStreamError({
        code: "unavailable",
        message: "Interrupted startup stream.",
        retryable: true,
      });
    this.beforeFinish();
    yield { type: this.cancelStartup ? "turn-cancelled" : "turn-completed" };
  }
}
