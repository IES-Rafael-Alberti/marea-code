import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
  type MareaModelGateway,
} from "@marea/deepagents-adapter";
import {
  ModelGatewayStreamChunkSchema,
  RequestIdSchema,
  type ModelGatewayRequest,
} from "@marea/protocol";
import { createConversationController, TurnFailureSignal } from "@marea/student-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createConversationStudentInterface } from "./conversation-interface.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { FixtureAgent, createFixtureController } from "./student.fixture.js";
import { classifyTurnFailure } from "./turn-failure.boundary.js";

/**
 * Field sequence (preview 48): the model fails with `invalid-response` after part of its answer
 * reached the screen, Marea retries on its own and the model writes a different answer. The
 * student must see only the new answer, the teacher must receive it once.
 */
const SHOWN = "Primero, revisa el bucle";
const REGENERATED = "Vale, empecemos por la condición del while.";

function fieldGateway(requests: ModelGatewayRequest[]): MareaModelGateway {
  return {
    async *stream(request) {
      await Promise.resolve();
      requests.push(request);
      const base = {
        protocolVersion: "0.1",
        requestId: request.requestId,
        modelAlias: "marea",
        emittedAt: "2026-11-26T10:00:00.000Z",
      };
      yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
      if (requests.length === 1) {
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 1,
          event: "text-delta",
          delta: SHOWN,
        });
        yield ModelGatewayStreamChunkSchema.parse({
          ...base,
          sequence: 2,
          event: "failed",
          code: "invalid-response",
          message: "The inference provider returned an invalid stream chunk.",
          retryable: false,
        });
        return;
      }
      yield ModelGatewayStreamChunkSchema.parse({
        ...base,
        sequence: 1,
        event: "text-delta",
        delta: REGENERATED,
      });
      yield ModelGatewayStreamChunkSchema.parse({
        ...base,
        sequence: 2,
        event: "completed",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
}

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marea-regenerated-"));
  await mkdir(join(directory, "project"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("replaces an answer cut off mid-stream with the regenerated one, on screen and for the teacher", async () => {
  const requests: ModelGatewayRequest[] = [];
  const checkpoint = createLocalCheckpoint({
    storageDirectory: join(directory, "state"),
    projectDirectory: join(directory, "project"),
  });
  const runtime = createDeepAgentsStudentRuntime({
    checkpoint,
    model: createMareaGatewayModel({
      gateway: fieldGateway(requests),
      nextRequestId: () => RequestIdSchema.parse(`request:${String(requests.length)}`),
    }),
  });
  const agent = new FixtureAgent();
  agent.streamMessage = (turn, signal) => runtime.streamMessage(turn, signal);
  const fixture = createFixtureController({ agent, liveProgress: true });
  const rendered: string[][] = [];
  try {
    await fixture.controller.start("Project One");
    const conversation = createConversationController({
      nextMessageId: () => "message:field",
      onExit: vi.fn(),
      onMessage: async (text, signal, messageId, attemptId) => {
        try {
          await fixture.controller.sendMessage(messageId, text, signal, attemptId);
        } catch (error) {
          throw new TurnFailureSignal(classifyTurnFailure(error));
        }
      },
      view: {
        dispose: vi.fn(),
        render: (snapshot) => {
          rendered.push(snapshot.messages.map((message) => `${message.author}:${message.text}`));
        },
      },
    });
    const studentInterface = createConversationStudentInterface({
      authentication: fixture.studentInterface,
      conversation,
    });
    fixture.studentInterface.present = (event) => {
      studentInterface.present(event);
    };

    expect(conversation.handle({ type: "submit", text: "¿Por qué no para?" })).toBe(true);
    await vi.waitFor(() => {
      expect(conversation.snapshot().status).toBe("ready");
    });

    // The partial answer was on screen, then left it before the new answer arrived.
    const partial = rendered.findIndex((messages) => messages.includes(`marea:${SHOWN}`));
    const answered = rendered.findIndex((messages) => messages.includes(`marea:${REGENERATED}`));
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(answered).toBeGreaterThan(partial);
    expect(rendered.slice(partial + 1, answered)).toContainEqual(["student:¿Por qué no para?"]);
    expect(conversation.snapshot().messages).toEqual([
      { author: "student", text: "¿Por qué no para?" },
      { author: "marea", text: REGENERATED },
    ]);
    expect(conversation.snapshot().failure).toBeUndefined();
    expect(requests).toHaveLength(2);
    conversation.dispose();

    await vi.waitFor(async () => {
      expect(await fixture.localSession.pendingEvents(128)).toEqual([]);
    });
    const events = [...fixture.server.events.values()].filter(
      (event) => "messageId" in event && event.messageId === "message:field",
    );
    expect(events.filter((event) => event.eventType === "assistant-message")).toEqual([
      expect.objectContaining({ content: REGENERATED }),
    ]);
    expect(events.filter((event) => event.eventType === "turn-failed")).toEqual([
      expect.objectContaining({
        category: "request-failed/provider.invalid-response",
        retryable: true,
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ eventType: "turn-ended", state: "completed" });
    expect(await fixture.controller.pendingTurn()).toBeNull();
  } finally {
    closeAgentCheckpoint(checkpoint);
  }
});
