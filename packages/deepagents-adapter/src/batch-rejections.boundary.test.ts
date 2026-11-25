import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createBatchRejections } from "./batch-rejections.boundary.js";

const actions = [
  { toolName: "marea_execute", arguments: { command: "dir" } },
  { toolName: "marea_execute", arguments: { command: "del a.txt" } },
];

function state(...messages: readonly object[]) {
  return { values: { messages } };
}

const batch = new AIMessage({
  content: "",
  tool_calls: [
    { id: "call-dir", name: "marea_execute", args: { command: "dir" }, type: "tool_call" },
    { id: "call-del", name: "marea_execute", args: { command: "del a.txt" }, type: "tool_call" },
  ],
});

describe("batch rejections", () => {
  it("passes uniform decisions to upstream unchanged", () => {
    const subject = createBatchRejections();
    expect(subject.plan(state(), actions, [{ type: "approve" }, { type: "approve" }])).toEqual([
      { type: "approve" },
      { type: "approve" },
    ]);
    expect(
      subject.plan(state(), actions, [
        { type: "approve" },
        { type: "amend", arguments: { command: "dir /b" } },
      ]),
    ).toEqual([
      { type: "approve" },
      { type: "edit", editedAction: { name: "marea_execute", args: { command: "dir /b" } } },
    ]);
    expect(
      subject.plan(state(), actions, [
        { type: "reject", reason: "No." },
        { type: "reject", reason: "Tampoco." },
      ]),
    ).toEqual([
      { type: "reject", message: "No." },
      { type: "reject", message: "Tampoco." },
    ]);
  });

  it("approves a mixed batch upstream and remembers each rejected call by its id", () => {
    const subject = createBatchRejections();
    expect(
      subject.plan(state(new HumanMessage("Hazlo"), batch), actions, [
        { type: "approve" },
        { type: "reject", reason: "No borres nada." },
      ]),
    ).toEqual([{ type: "approve" }, { type: "approve" }]);
  });

  it("keeps an amended action amended in a mixed batch", () => {
    expect(
      createBatchRejections().plan(state(batch), actions, [
        { type: "amend", arguments: { command: "dir /b" } },
        { type: "reject", reason: "No." },
      ]),
    ).toEqual([
      { type: "edit", editedAction: { name: "marea_execute", args: { command: "dir /b" } } },
      { type: "approve" },
    ]);
  });

  it("answers each rejected call once with the reason and lets every other call run", async () => {
    const subject = createBatchRejections();
    subject.plan(state(batch, new HumanMessage("Later")), actions, [
      { type: "approve" },
      { type: "reject", reason: "No borres nada." },
    ]);
    const wrap = subject.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("The middleware wraps tool calls.");
    const handler = vi.fn(() => "ran");
    const call = (id: string) =>
      wrap(
        { toolCall: { id, name: "marea_execute", args: {} } } as Parameters<typeof wrap>[0],
        handler as never,
      );
    const answered = await call("call-del");
    expect(answered).toBeInstanceOf(ToolMessage);
    expect(answered).toMatchObject({ tool_call_id: "call-del", content: "No borres nada." });
    expect(handler).not.toHaveBeenCalled();
    expect(await call("call-dir")).toBe("ran");
    expect(await call("call-del")).toBe("ran");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("refuses a graph state without its message list", () => {
    for (const graph of [{}, { values: {} }])
      expect(() =>
        createBatchRejections().plan(graph, actions, [
          { type: "approve" },
          { type: "reject", reason: "No." },
        ]),
      ).toThrow(z.ZodError);
  });

  it.each([
    ["fewer decisions", [{ type: "approve" }]],
    ["more decisions", [{ type: "approve" }, { type: "approve" }, { type: "approve" }]],
  ] as const)("refuses %s than pending actions", (_label, decisions) => {
    expect(() => createBatchRejections().plan(state(batch), actions, decisions)).toThrow(
      "unsupported approval payload",
    );
  });

  it.each([
    ["no model message", state(new HumanMessage("Hazlo"))],
    [
      "a different tool",
      state(
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "a", name: "marea_delete", args: { command: "dir" }, type: "tool_call" },
            { id: "b", name: "marea_execute", args: { command: "del a.txt" }, type: "tool_call" },
          ],
        }),
      ),
    ],
    [
      "different arguments",
      state(
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "a", name: "marea_execute", args: { command: "dir" }, type: "tool_call" },
            { id: "b", name: "marea_execute", args: { command: "other" }, type: "tool_call" },
          ],
        }),
      ),
    ],
  ])("refuses a mixed batch whose calls cannot be found: %s", (_label, graph) => {
    expect(() =>
      createBatchRejections().plan(graph, actions, [
        { type: "approve" },
        { type: "reject", reason: "No." },
      ]),
    ).toThrow("unsupported approval payload");
  });

  it("does not match one call twice when two actions are identical", () => {
    const twice = [actions[0], actions[0]] as typeof actions;
    expect(() =>
      createBatchRejections().plan(
        state(
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "a", name: "marea_execute", args: { command: "dir" }, type: "tool_call" },
            ],
          }),
        ),
        twice,
        [{ type: "approve" }, { type: "reject", reason: "No." }],
      ),
    ).toThrow("unsupported approval payload");
  });
});
