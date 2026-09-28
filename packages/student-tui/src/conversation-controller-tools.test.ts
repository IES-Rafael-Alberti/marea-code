import { describe, expect, it } from "vitest";

import { createConversationControllerTarget as setup } from "./conversation-controller.test-support.js";

describe("conversation controller tools", () => {
  it("records tool rows for the active turn and ignores stale identities", async () => {
    const target = setup();

    expect(target.controller.toolStarted({ arguments: {}, callId: "call:old", name: "x" })).toBe(
      false,
    );
    expect(target.controller.toolFinished({ callId: "call:old", failed: false, result: "r" })).toBe(
      false,
    );
    target.controller.handle({ type: "submit", text: "Read it" });
    expect(
      target.controller.toolStarted(
        { arguments: { path: "a.txt" }, callId: "call:1", name: "marea_read_project" },
        "foreign",
      ),
    ).toBe(false);
    expect(
      target.controller.toolStarted({
        arguments: { extra: "unseen", path: "a.txt" },
        callId: "call:1",
        name: "marea_read_project",
      }),
    ).toBe(true);
    expect(
      target.controller.toolStarted({
        arguments: { path: "b.txt" },
        callId: "call:2",
        name: "marea_read_project",
      }),
    ).toBe(true);
    expect(target.controller.snapshot().tools).toEqual([
      {
        arguments: { extra: "unseen", path: "a.txt" },
        callId: "call:1",
        name: "marea_read_project",
        outcome: null,
      },
      {
        arguments: { path: "b.txt" },
        callId: "call:2",
        name: "marea_read_project",
        outcome: null,
      },
    ]);
    expect(
      target.controller.toolFinished({ callId: "call:1", failed: false, result: "content" }),
    ).toBe(true);
    expect(target.controller.snapshot().tools).toEqual([
      {
        arguments: { extra: "unseen", path: "a.txt" },
        callId: "call:1",
        name: "marea_read_project",
        outcome: { failed: false, result: "content" },
      },
      {
        arguments: { path: "b.txt" },
        callId: "call:2",
        name: "marea_read_project",
        outcome: null,
      },
    ]);
    target.controller.complete();
    await Promise.resolve();
    target.controller.handle({ type: "submit", text: "Next" });
    expect(target.controller.snapshot().tools).toBeUndefined();
    target.controller.cancel();
  });
});

it("accepts thinking only for the active attempt and clears it on visible work", () => {
  const target = setup();
  expect(target.controller.thinking()).toBe(false);
  target.controller.handle({ type: "submit", text: "Help" });
  expect(target.controller.thinking("stale", "stale")).toBe(false);
  expect(target.controller.thinking()).toBe(true);
  expect(target.controller.snapshot().activity).toBe("thinking");
  target.controller.appendAssistantText("Hello");
  expect(target.controller.snapshot().activity).toBeUndefined();
  target.controller.thinking();
  target.controller.toolStarted({ callId: "public", name: "read_file", arguments: {} });
  expect(target.controller.snapshot().activity).toBeUndefined();
  target.controller.thinking();
  target.controller.toolFinished({ callId: "public", failed: false, result: "Public text" });
  expect(target.controller.snapshot().activity).toBeUndefined();
  target.controller.cancel();
  expect(target.controller.thinking()).toBe(false);
});
