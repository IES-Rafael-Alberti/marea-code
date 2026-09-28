import type { ToolLifecycleEvent } from "./tool-events.boundary.js";
import { expect, it } from "vitest";
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
