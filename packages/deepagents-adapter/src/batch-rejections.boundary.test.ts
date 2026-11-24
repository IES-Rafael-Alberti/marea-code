import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

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
