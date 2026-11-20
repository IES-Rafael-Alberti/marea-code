import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  closeAgentCheckpoint,
  createLocalCheckpoint,
  createMareaGatewayModel,
} from "@marea/deepagents-adapter";
import {
  RequestIdSchema,
  SkillIdSchema,
  STARTUP_MESSAGE_ID,
  ModelGatewayStreamChunkSchema,
  type ModelGatewayRequest,
} from "@marea/protocol";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { snapshot, runId, collect, message } from "./deepagents-runtime.fixture.js";
import { loadRequiredSkills } from "./required-skill-context.js";

it("sends mandatory instructions in every real model request, including after a checkpoint reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "marea-required-skills-"));
  const projectDirectory = join(root, "project");
  const storageDirectory = join(root, "state");
  mkdirSync(projectDirectory);
  let checkpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
  const requests: ModelGatewayRequest[] = [];
  const gateway = {
    async *stream(request: ModelGatewayRequest) {
      await Promise.resolve();
      requests.push(request);
      const base = {
        protocolVersion: request.protocolVersion,
        requestId: request.requestId,
        modelAlias: request.modelAlias,
        emittedAt: "2026-11-20T10:00:00.000Z",
      };
      yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
      yield ModelGatewayStreamChunkSchema.parse({
        ...base,
        sequence: 1,
        event: "text-delta",
        delta: "Exercise ready.",
      });
      yield ModelGatewayStreamChunkSchema.parse({
        ...base,
        sequence: 2,
        event: "completed",
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1 },
      });
    },
  };
  let next = 0;
  const model = createMareaGatewayModel({
    gateway,
    nextRequestId: () => RequestIdSchema.parse(`request:${String(++next)}`),
  });
  const value = {
    ...snapshot(),
    startup: snapshot().prompt,
    didacticSkills: [
      { id: SkillIdSchema.parse("teacher/ana/example"), digest: snapshot().prompt.digest },
    ],
  };
  const body = "Mandatory rule: ask the student to explain the test before writing code.";
  const loadSkills = (
    _runId: typeof runId,
    captured: typeof value | ReturnType<typeof snapshot>,
    signal: AbortSignal,
  ) => loadRequiredSkills(captured, { read: () => Promise.resolve(body) }, signal);
  const signal = new AbortController().signal;
  try {
    const runtime = createDeepAgentsStudentRuntime({ checkpoint, model, loadSkills });
    await runtime.prepare?.({ runId, snapshot: value }, signal);
    await collect(
      runtime.streamStartup({ runId, snapshot: value, messageId: STARTUP_MESSAGE_ID }, signal),
    );
    await collect(runtime.streamMessage(message(value), signal));
    closeAgentCheckpoint(checkpoint);
    checkpoint = createLocalCheckpoint({ projectDirectory, storageDirectory });
    const resumed = createDeepAgentsStudentRuntime({ checkpoint, model, loadSkills });
    await resumed.prepare?.({ runId, snapshot: value }, signal);
    await collect(resumed.streamMessage({ ...message(value), messageId: "message:2" }, signal));
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(
        request.messages
          .filter(({ role }) => role === "system")
          .map(({ content }) => content)
          .join("\n"),
      ).toContain(body);
      expect(request.messages.some(({ role }) => role === "tool")).toBe(false);
    }
  } finally {
    closeAgentCheckpoint(checkpoint);
    rmSync(root, { recursive: true, force: true });
  }
});
