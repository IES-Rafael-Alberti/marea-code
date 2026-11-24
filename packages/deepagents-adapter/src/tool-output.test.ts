import { expect, it } from "vitest";

import { createControlledTools } from "./controlled-tools.boundary.js";
import { ReadOnlyToolInputError } from "./contracts.js";
import { createReadOnlyTools } from "./read-tools.boundary.js";
import { boundToolResult, TOOL_RESULT_CHARACTERS } from "./tool-output.js";

it("keeps tool results within one gateway message and says what was omitted", () => {
  expect(boundToolResult("short")).toBe("short");
  const exact = "a".repeat(TOOL_RESULT_CHARACTERS);
  expect(boundToolResult(exact)).toBe(exact);
  const bounded = boundToolResult(`${exact}tail`);
  expect(bounded).toBe(
    `${exact}\n[Marea truncated this tool result: 4 of ${String(TOOL_RESULT_CHARACTERS + 4)} characters were omitted. Ask for a smaller range or a narrower command to see the rest.]`,
  );
  expect(bounded.length).toBeLessThanOrEqual(65_536);
  expect(boundToolResult("")).toBe("(The tool returned no output.)");
});

it("bounds read and controlled tool results returned to the model", async () => {
  const large = "r".repeat(70_000);
  const [reader, rejected] = createReadOnlyTools(
    [
      {
        name: "marea_read_project",
        description: "Synthetic reader",
        execute: () => Promise.resolve(large),
      },
      {
        name: "marea_list_project",
        description: "Synthetic rejected reader",
        execute: () => Promise.reject(new ReadOnlyToolInputError("e".repeat(70_000))),
      },
    ],
    "confirm_change",
    () => undefined,
  );
  const {
    tools: [effect],
  } = createControlledTools(
    [{ name: "confirm_change", description: "Synthetic", execute: () => Promise.resolve("") }],
    () => undefined,
  );

  expect(await reader?.invoke({ path: "big.txt" })).toBe(boundToolResult(large));
  expect(await rejected?.invoke({ path: "/" })).toBe(
    boundToolResult(`Error: ${"e".repeat(70_000)}`),
  );
  expect(await effect?.invoke({ path: "x" })).toBe("(The tool returned no output.)");
});
