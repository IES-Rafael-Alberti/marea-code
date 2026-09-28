import { describe, expect, it } from "vitest";

import type { OpenRouterToolCallDelta } from "./contracts.js";
import { ToolCallAccumulator } from "./tool-calls.boundary.js";

function expectInvalid(...deltas: readonly OpenRouterToolCallDelta[]): void {
  const accumulator = new ToolCallAccumulator();
  expect(() => {
    accumulator.add(deltas);
    accumulator.finish();
  }).toThrow(
    expect.objectContaining({
      code: "invalid-response",
      message: "The inference provider returned an invalid tool call.",
      retryable: false,
    }),
  );
}

describe("OpenRouter tool-call boundary", () => {
  it("retains accumulated arguments when a continuation omits them", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add([
      {
        arguments: '{"path":"a.txt"}',
        id: "call-1",
        index: 0,
        name: "write_file",
      },
      { index: 0 },
    ]);

    expect(accumulator.finish()).toEqual([
      {
        arguments: { path: "a.txt" },
        callId: "call-1",
        name: "write_file",
        type: "tool-call",
      },
    ]);
  });

  it("rejects independently missing identifiers and names", () => {
    expectInvalid({ arguments: "{}", index: 0, name: "write_file" });
    expectInvalid({ arguments: "{}", id: "call-1", index: 0 });
  });

  it("rejects malformed JSON and invalid argument records", () => {
    expectInvalid({ arguments: "{", id: "call-1", index: 0, name: "write_file" });
    expectInvalid({ arguments: '{"": "value"}', id: "call-1", index: 0, name: "write_file" });
  });
});
