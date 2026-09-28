import { expect, it } from "vitest";
import { FixtureAgent, createFixtureController } from "./student.fixture.js";

it("records private reads for the teacher before filtering the student presentation, retaining errors and public reads", async () => {
  const agent = new FixtureAgent();
  agent.streamMessage = async function* () {
    await Promise.resolve();
    yield {
      type: "tool-started",
      callId: "private",
      name: "marea_read_skill",
      arguments: { path: "private/SKILL.md" },
    };
    yield { type: "tool-finished", callId: "private", result: "PRIVATE_CONTENT", failed: true };
    yield {
      type: "tool-started",
      callId: "public",
      name: "marea_read_project",
      arguments: { file_path: "main.py", path: "ignored", command: "ignored" },
    };
    yield { type: "tool-finished", callId: "public", result: "print(1)", failed: false };
    yield { type: "turn-completed" };
  };
  const fixture = createFixtureController({ agent });
  await fixture.controller.start("Project");
  await fixture.controller.sendMessage("message:tools", "Help", new AbortController().signal);
  const events = [...fixture.server.events.values()].filter(
    (event) => event.eventType === "tool-started" || event.eventType === "tool-finished",
  );
  expect(events).toMatchObject([
    {
      eventType: "tool-started",
      callId: "private",
      name: "marea_read_skill",
      target: "private/SKILL.md",
      arguments: JSON.stringify({ path: "private/SKILL.md" }, null, 2),
      truncated: false,
      messageId: "message:tools",
    },
    {
      eventType: "tool-finished",
      callId: "private",
      result: "PRIVATE_CONTENT",
      failed: true,
      truncated: false,
    },
    {
      eventType: "tool-started",
      callId: "public",
      name: "marea_read_project",
      target: "main.py",
      truncated: false,
    },
    {
      eventType: "tool-finished",
      callId: "public",
      result: "print(1)",
      failed: false,
      truncated: false,
    },
  ]);
  expect(events.map((event) => event.sequence)).toEqual([3, 4, 5, 6]);
  expect(JSON.stringify(fixture.studentInterface.events)).not.toMatch(
    /PRIVATE_CONTENT|private\/SKILL/,
  );
});

it.each([
  [{ command: "test" }, "test", false],
  [{}, "", false],
  [{ path: "p".repeat(2048) }, "p".repeat(2048), false],
  [{ path: "p".repeat(2049) }, "p".repeat(2048), true],
  [{ content: "c".repeat(65_536 - JSON.stringify({ content: "" }, null, 2).length) }, "", false],
  [{ content: "c".repeat(65_536) }, "", true],
] as const)(
  "records bounded arguments and an explicit truncation indicator",
  async (arguments_, target, truncated) => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { type: "tool-started", callId: "call", name: "read", arguments: arguments_ };
      yield { type: "tool-finished", callId: "call", result: "x".repeat(65_537), failed: false };
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project");
    await fixture.controller.sendMessage("message:bounds", "Help", new AbortController().signal);
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "tool-started",
        arguments: JSON.stringify(arguments_, null, 2).slice(0, 65_536),
        target,
        truncated,
      }),
    );
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "tool-finished",
        result: "x".repeat(65_536),
        truncated: true,
      }),
    );
  },
);

it.each([65_535, 65_536, 65_537])(
  "marks output truncation only above the exact limit (%s)",
  async (length) => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { type: "tool-finished", callId: "call", result: "x".repeat(length), failed: false };
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project");
    await fixture.controller.sendMessage("message:output", "Help", new AbortController().signal);
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({
        eventType: "tool-finished",
        result: "x".repeat(Math.min(length, 65_536)),
        truncated: length > 65_536,
      }),
    );
  },
);

it("records exact text boundaries and original tool times even without live progress", async () => {
  const agent = new FixtureAgent();
  agent.streamMessage = async function* () {
    await Promise.resolve();
    yield { type: "assistant-text-delta", text: "Before" };
    yield {
      type: "tool-started",
      callId: "read",
      name: "marea_read_skill",
      arguments: {},
      occurredAt: "2026-09-21T10:00:01.000Z",
    };
    yield {
      type: "tool-finished",
      callId: "read",
      result: "skill",
      failed: false,
      occurredAt: "2026-09-21T10:00:02.000Z",
    };
    yield { type: "assistant-text-delta", text: "After" };
    yield { type: "turn-completed" };
  };
  const f = createFixtureController({ agent });
  await f.controller.start("Order");
  await f.controller.sendMessage("message:order", "Help", new AbortController().signal);
  const events = [...f.server.events.values()];
  expect(events.find((event) => event.eventType === "tool-started")).toMatchObject({
    assistantTextOffset: 6,
    occurredAt: "2026-09-21T10:00:01.000Z",
  });
  expect(events.find((event) => event.eventType === "tool-finished")).toMatchObject({
    occurredAt: "2026-09-21T10:00:02.000Z",
  });
  expect(events.find((event) => event.eventType === "assistant-message")).toMatchObject({
    content: "BeforeAfter",
  });
});
