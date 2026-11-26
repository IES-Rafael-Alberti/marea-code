import type { ToolLifecycleEvent } from "./tool-events.boundary.js";
import { expect, it } from "vitest";
import type { WhenPredicate } from "langchain";
import { createControlledTools } from "./controlled-tools.boundary.js";
import { QUESTION_TOOL_NAME } from "./questions.boundary.js";
it.each([QUESTION_TOOL_NAME, "duplicate"])(
  "rejects a controlled tool collision with %s",
  (name) => {
    const effect = { name, description: "Synthetic", execute: () => Promise.resolve("unused") };
    expect(() => createControlledTools([effect, effect], () => undefined)).toThrow("unique");
  },
);
it("does not report execution twice when the caller observes the actual effect", async () => {
  const reports: ToolLifecycleEvent[] = [];
  const { tools } = createControlledTools(
    [
      {
        name: "external_effect",
        description: "Previously persisted result",
        lifecycle: "external",
        execute: (input) => {
          expect(Object.isFrozen(input)).toBe(true);
          return Promise.resolve(input.value ?? "missing");
        },
      },
    ],
    (event) => reports.push(event),
  );
  expect(await tools[0]?.invoke({ value: "recorded result" })).toBe("recorded result");
  expect(reports).toEqual([]);
});
it("reserves the question channel even when only one effect is supplied", () => {
  expect(() =>
    createControlledTools(
      [
        {
          name: QUESTION_TOOL_NAME,
          description: "Collision",
          execute: () => Promise.resolve("unused"),
        },
      ],
      () => undefined,
    ),
  ).toThrow(expect.objectContaining({ code: "invalid-runtime-dependency" }));
});
it("asks approval for every effect and gates it only when a blocking predicate is supplied", async () => {
  const effect = {
    name: "write_note",
    description: "Synthetic",
    execute: () => Promise.resolve("done"),
  };
  const decisions = ["approve", "edit", "reject"];
  expect(createControlledTools([effect], () => undefined).interrupts).toEqual({
    write_note: { allowedDecisions: decisions },
  });
  let blocked = true;
  const request: Parameters<WhenPredicate>[0] = Object.freeze({}) as Parameters<WhenPredicate>[0];
  const seen: Parameters<WhenPredicate>[0][] = [];
  const gated = createControlledTools(
    [effect],
    () => undefined,
    (received) => {
      seen.push(received);
      return Promise.resolve(blocked);
    },
  ).interrupts.write_note;
  expect(gated?.allowedDecisions).toEqual(decisions);
  // A blocked call needs no approval interrupt; an unblocked one does.
  expect(await gated?.when?.(request)).toBe(false);
  blocked = false;
  expect(await gated?.when?.(request)).toBe(true);
  expect(seen).toEqual([request, request]);
});
