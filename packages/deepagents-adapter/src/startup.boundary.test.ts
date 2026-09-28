import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { STARTUP_MESSAGE_ID } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { collect, MareaFakeModel, signal, unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { createTurnInput, isTurnInput } from "./turn-input.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";

const turn = {
  kind: "startup" as const,
  sessionId: "run:startup",
  messageId: STARTUP_MESSAGE_ID,
  text: "Inspect and propose one exercise.",
};

describe("internal read-only tutor turn", () => {
  it("advertises no tools when startup has no host readers", async () => {
    const model = new MareaFakeModel().respond(new AIMessage("Which project?"));
    const runtime = createAgentRuntime({
      model: bindTestModel(model),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: unusedTool,
      systemPrompt: "Marea tutor.",
      readOnly: true,
    });
    await collect(runtime.streamMessage(turn, signal()));
    expect(model.boundToolNames.flat()).toEqual([]);
  });

  it("retains approval tooling when read-only mode is explicitly disabled", async () => {
    const execute = vi.fn(() => Promise.resolve("changed"));
    const model = new MareaFakeModel().respond(
      new AIMessage({
        content: "",
        tool_calls: [{ id: "call:effect", name: unusedTool.name, args: {} }],
      }),
    );
    const runtime = createAgentRuntime({
      model: bindTestModel(model),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: { ...unusedTool, execute },
      systemPrompt: "Marea tutor.",
      readOnly: false,
    });
    const events = await collect(
      runtime.streamMessage(
        { sessionId: "run:editable", messageId: "message:editable", text: "Make an edit." },
        signal(),
      ),
    );
    expect(model.boundToolNames.flat()).toContain(unusedTool.name);
    expect(events.at(-1)).toMatchObject({ type: "tool-approval-required" });
    expect(execute).not.toHaveBeenCalled();
    expect(() => runtime.streamMessage(turn, signal())).toThrow(
      "Tutor startup requires a read-only runtime.",
    );
  });

  it("uses a system turn, omits effect tools and recovers without another model call", async () => {
    const checkpoint = createInMemoryCheckpointForTest();
    const execute = vi.fn(() => Promise.resolve("changed"));
    const model = new MareaFakeModel().respond(new AIMessage("One exercise."));
    const runtime = createAgentRuntime({
      model: bindTestModel(model),
      checkpoint,
      approvalTool: { ...unusedTool, execute },
      readOnly: true,
      readOnlyTools: [
        {
          name: "marea_read_project",
          description: "Read the project.",
          execute: unusedTool.execute.bind(unusedTool),
        },
        {
          name: "marea_list_project",
          description: "List project files.",
          execute: unusedTool.execute.bind(unusedTool),
        },
      ],
      systemPrompt: "Marea tutor.",
    });
    expect(await collect(runtime.streamMessage(turn, signal()))).toEqual([
      { type: "assistant-text-delta", text: "One exercise." },
      { type: "turn-completed" },
    ]);
    expect(model.calls[0]?.messages.some((message) => HumanMessage.isInstance(message))).toBe(
      false,
    );
    expect(
      model.calls[0]?.messages.some(
        (message) =>
          SystemMessage.isInstance(message) &&
          message.id === STARTUP_MESSAGE_ID &&
          message.text === turn.text,
      ),
    ).toBe(true);
    expect(model.boundToolNames.flat()).not.toContain(unusedTool.name);
    expect(model.boundToolNames.flat()).not.toContain("execute");
    expect(model.boundToolNames.flat()).not.toContain("write_file");
    expect(model.boundToolNames.flat()).not.toContain("edit_file");
    expect(model.boundToolNames.flat()).toEqual(["marea_read_project", "marea_list_project"]);
    expect(execute).not.toHaveBeenCalled();
    const nextModel = new MareaFakeModel().respond(new AIMessage("Next answer."));
    const next = createAgentRuntime({
      model: bindTestModel(nextModel),
      checkpoint,
      approvalTool: unusedTool,
      systemPrompt: "Marea tutor.",
    });
    await collect(
      next.streamMessage(
        { sessionId: turn.sessionId, messageId: "message:student", text: "Now help me." },
        signal(),
      ),
    );
    expect(
      nextModel.calls[0]?.messages.filter((message) => HumanMessage.isInstance(message)),
    ).toHaveLength(1);
    expect(
      nextModel.calls[0]?.messages.filter(
        (message) => SystemMessage.isInstance(message) && message.id === STARTUP_MESSAGE_ID,
      ),
    ).toHaveLength(1);
    const recoveredModel = new MareaFakeModel();
    const recovered = createAgentRuntime({
      model: bindTestModel(recoveredModel),
      checkpoint,
      approvalTool: unusedTool,
      systemPrompt: "Marea tutor.",
      readOnly: true,
    });
    expect(
      await collect(recovered.streamMessage({ ...turn, assistantText: "One " }, signal())),
    ).toEqual([{ type: "assistant-text-delta", text: "exercise." }, { type: "turn-completed" }]);
    expect(recoveredModel.callCount).toBe(0);
    expect(
      await recovered.recoverMessage({ sessionId: turn.sessionId, messageId: STARTUP_MESSAGE_ID }),
    ).toMatchObject({ type: "completed", assistantText: "One exercise." });
  });

  it("refuses to run an internal startup with effect tools enabled", () => {
    const runtime = createAgentRuntime({
      model: bindTestModel(new MareaFakeModel()),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: unusedTool,
      systemPrompt: "Marea tutor.",
    });
    expect(() => runtime.streamMessage(turn, signal())).toThrow(
      "Tutor startup requires a read-only runtime.",
    );
  });

  it("keeps the reserved identity distinct from normal student messages", () => {
    const { kind, ...studentTurn } = turn;
    expect(kind).toBe("startup");
    for (const input of [{ ...turn, messageId: "message:student" }, studentTurn]) {
      expect(() => createTurnInput(input)).toThrow(
        expect.objectContaining({ code: "invalid-message-id" }),
      );
      expect(() => createTurnInput(input)).toThrow(
        "The internal startup identity cannot be used as a student message.",
      );
    }
    const human = createTurnInput({
      sessionId: "run:student",
      messageId: "message:student",
      text: "Hello",
    });
    expect(HumanMessage.isInstance(human)).toBe(true);
    expect(human.id).toBe("message:student");
    expect(human.text).toBe("Hello");
    const internal = createTurnInput(turn);
    expect(SystemMessage.isInstance(internal)).toBe(true);
    expect(isTurnInput(internal)).toBe(true);
    expect(isTurnInput(human)).toBe(true);
    expect(
      isTurnInput(new SystemMessage({ content: "General instructions.", id: "system:base" })),
    ).toBe(false);
    expect(isTurnInput(new AIMessage("Output"))).toBe(false);
    expect(isTurnInput(null)).toBe(false);
  });
});
