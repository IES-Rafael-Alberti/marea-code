import type { AgentRuntimeOptions } from "@marea/deepagents-adapter";
import { describe, expect, it, vi } from "vitest";
import { SkillIdSchema, STARTUP_MESSAGE_ID } from "@marea/protocol";
import {
  RequiredSkillContext,
  RequiredSkillsError,
  loadRequiredSkills,
} from "./required-skill-context.js";
import {
  checkpoint,
  model,
  runId,
  snapshot,
  message,
  collect,
} from "./deepagents-runtime.fixture.js";
import { createDeepAgentsStudentRuntime } from "./deepagents-runtime.boundary.js";
import { classifyTurnFailure } from "./turn-failure.boundary.js";
import { createFixtureController } from "./student.fixture.js";
import { StartupFixtureAgent, StartupFixtureServer } from "./startup.fixture.js";

const captured = () => ({
  ...snapshot(),
  didacticSkills: [
    { id: SkillIdSchema.parse("teacher/ana/one"), digest: snapshot().prompt.digest },
    { id: SkillIdSchema.parse("teacher/pedro/two"), digest: snapshot().prompt.digest },
  ],
});
const signal = () => new AbortController().signal;

describe("mandatory didactic context", () => {
  it("loads every complete SKILL.md in selection order without paginating or loading auxiliary files", async () => {
    const content = "á".repeat(10_000) + " final rule";
    const read = vi.fn().mockResolvedValue(content);
    const result = await loadRequiredSkills(captured(), { read }, signal());
    expect(read.mock.calls).toEqual(captured().didacticSkills.map(({ id }) => [id, "SKILL.md"]));
    expect(result.split(content)).toHaveLength(3);
    expect(result).toContain("Explicit class instructions");
  });

  it("fails closed, caches only complete loads and refuses a different snapshot", async () => {
    const context = new RequiredSkillContext();
    expect(() => context.content(runId, captured())).toThrow(RequiredSkillsError);
    await expect(context.prepare(runId, captured(), signal())).rejects.toThrow(RequiredSkillsError);
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("private details"))
      .mockResolvedValue("full material");
    await expect(context.prepare(runId, captured(), signal(), load)).rejects.toThrow(
      "could not be loaded",
    );
    expect(() => context.content(runId, captured())).toThrow();
    await context.prepare(runId, captured(), signal(), load);
    await context.prepare(runId, captured(), signal(), load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(context.content(runId, captured())).toBe("full material");
    await expect(
      context.prepare(runId, { ...captured(), id: snapshot("snapshot:other").id }, signal(), load),
    ).rejects.toThrow();
  });

  it("does not load didactic materials in free mode or an empty selection", async () => {
    const context = new RequiredSkillContext();
    const load = vi.fn();
    for (const value of [snapshot(), { ...captured(), agentMode: "free" as const }]) {
      await context.prepare(runId, value, signal(), load);
      expect(context.content(runId, value)).toBe("");
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses oversized material without truncation and exposes a recoverable failure", async () => {
    const context = new RequiredSkillContext();
    await expect(
      context.prepare(runId, captured(), signal(), () => Promise.resolve("x".repeat(48_000))),
    ).rejects.toThrow("reduce");
    expect(() => context.content(runId, captured())).toThrow();
    const failure = classifyTurnFailure(new RequiredSkillsError());
    expect(failure).toMatchObject({ kind: "request-failed", retryable: true, recoverable: true });
    expect(failure.detail).not.toContain("teacher/ana");
  });

  it("never commits a cancelled load and permits a fresh retry", async () => {
    const controller = new AbortController();
    const context = new RequiredSkillContext();
    const load = vi.fn(() => {
      controller.abort();
      return Promise.resolve("material");
    });
    await expect(context.prepare(runId, captured(), controller.signal, load)).rejects.toThrow();
    expect(() => context.content(runId, captured())).toThrow();
    await context.prepare(runId, captured(), signal(), () => Promise.resolve("material"));
    const read = vi.fn(() => {
      controller.abort();
      return Promise.resolve("material");
    });
    await expect(loadRequiredSkills(captured(), { read }, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("pins the complete material in startup and conversation system prompts and reloads on process resume", async () => {
    const value = { ...captured(), startup: snapshot().prompt };
    const loadSkills = vi.fn().mockResolvedValue("Frozen instructions: mandatory rule.");
    const configured: AgentRuntimeOptions[] = [];
    const createRuntime = vi.fn((options: AgentRuntimeOptions) => {
      configured.push(options);
      return {
        recoverMessage: () => Promise.resolve(null),
        async *streamMessage() {
          await Promise.resolve();
          yield { type: "turn-completed" as const };
        },
        async *resumeApproval() {
          await Promise.resolve();
          yield { type: "turn-completed" as const };
        },
      };
    });
    const options = { checkpoint, model, loadSkills, createRuntime };
    const runtime = createDeepAgentsStudentRuntime(options);
    expect(() => runtime.streamMessage(message(value), signal())).toThrow(RequiredSkillsError);
    await runtime.prepare?.({ runId, snapshot: value }, signal());
    await collect(
      runtime.streamStartup({ ...message(value), messageId: STARTUP_MESSAGE_ID }, signal()),
    );
    await collect(runtime.streamMessage(message(value), signal()));
    const resumed = createDeepAgentsStudentRuntime(options);
    await resumed.prepare?.({ runId, snapshot: value }, signal());
    await collect(resumed.streamMessage(message(value), signal()));
    expect(loadSkills).toHaveBeenCalledTimes(2);
    expect(createRuntime).toHaveBeenCalledTimes(3);
    for (const options of configured) {
      expect(options.systemPrompt).toBe("Frozen instructions: mandatory rule.\n\nTeach clearly.");
    }
  });

  it("blocks startup before the agent runs and lets the same startup retry after loading recovers", async () => {
    const startup = new StartupFixtureAgent();
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new RequiredSkillsError())
      .mockResolvedValue(undefined);
    const agent = Object.assign(startup, { prepare });
    const server = new StartupFixtureServer();
    const open = server.openRun.bind(server);
    vi.spyOn(server, "openRun").mockImplementation(async (token, request) => {
      const opened = await open(token, request);
      return {
        ...opened,
        snapshot: { ...opened.snapshot, didacticSkills: captured().didacticSkills },
      };
    });
    const test = createFixtureController({ agent, server });
    await test.controller.start("Project One");
    await expect(test.controller.sendStartup(signal())).rejects.toThrow();
    expect(startup.startups).toHaveLength(0);
    expect(test.state.state.run?.turns[0]?.lastFailure?.retryable).toBe(true);
    await test.controller.sendStartup(signal());
    expect(startup.startups).toHaveLength(1);
    expect(
      test.studentInterface.events.filter((event) => event.type === "skills-loading"),
    ).toHaveLength(2);
    expect(test.studentInterface.events.some((event) => event.type === "thinking")).toBe(true);
  });
});

it("checks the complete assembled prompt, including project context, without changing the stored snapshot", async () => {
  const context = new RequiredSkillContext();
  const value = captured();
  await context.prepare(runId, value, signal(), () => Promise.resolve("material"));
  expect(context.prompt(runId, value, "project facts")).toBe(
    "material\n\nTeach clearly.\n\nproject facts",
  );
  expect(() => context.prompt(runId, value, "x".repeat(60_000))).toThrow("reduce");
  expect(value.prompt.content).toBe("Teach clearly.");
});
