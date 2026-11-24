import { describe, expect, it } from "vitest";

import type { OpenRouterToolCallDelta } from "./contracts.js";
import { ToolCallAccumulator, UNKNOWN_TOOL_NAME } from "./tool-calls.boundary.js";

function finish(...deltas: readonly OpenRouterToolCallDelta[]) {
  const accumulator = new ToolCallAccumulator("request:synthetic");
  accumulator.add(deltas);
  return accumulator.finish();
}

function single(argumentsText: string, name = "grep", id = "call-1") {
  const [event] = finish({ arguments: argumentsText, id, index: 0, name });
  return event;
}

describe("OpenRouter tool-call boundary", () => {
  it("retains accumulated arguments when a continuation omits them", () => {
    const accumulator = new ToolCallAccumulator("request:synthetic");
    accumulator.add([
      { arguments: '{"path":"a.txt"}', id: "call-1", index: 0, name: "write_file" },
      { index: 0 },
    ]);
    expect(accumulator.finish()).toEqual([
      { arguments: { path: "a.txt" }, callId: "call-1", name: "write_file", type: "tool-call" },
    ]);
  });

  it("orders calls by index and keeps a well-formed call without repair metadata", () => {
    const events = finish(
      { arguments: '{"b":"2"}', id: "call-b", index: 1, name: "ls" },
      { arguments: '{"a":"1"}', id: "call-a", index: 0, name: "glob" },
    );
    expect(events.map((event) => (event.type === "tool-call" ? event.callId : null))).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(events[0]).not.toHaveProperty("repair");
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("treats empty arguments as an empty record without repair", () => {
    expect(single("")).toEqual({
      arguments: {},
      callId: "call-1",
      name: "grep",
      type: "tool-call",
    });
    expect(single("  ")).not.toHaveProperty("repair");
  });

  it.each([
    ['{"offset":20}', { offset: "20" }],
    ['{"recursive":true}', { recursive: "true" }],
    ['{"paths":["a","b"]}', { paths: '["a","b"]' }],
    ['{"options":{"limit":2}}', { options: '{"limit":2}' }],
    ['{"pattern":"x","offset":null}', { pattern: "x" }],
  ])("converts non-text argument %s to text and continues", (text, expected) => {
    expect(single(text)).toEqual({
      arguments: expected,
      callId: "call-1",
      name: "grep",
      type: "tool-call",
      repair: { causes: ["non-string-argument"], rawName: "grep", rawArguments: text },
    });
  });

  it.each(['{"pattern":"x"', "[1,2]", "null", '"text"', "7"])(
    "emits unreadable arguments %s as an empty record for the tool to explain",
    (text) => {
      expect(single(text)).toMatchObject({
        arguments: {},
        repair: { causes: ["malformed-arguments"], rawArguments: text },
      });
    },
  );

  it.each(["", "k".repeat(129)])(
    "drops the argument name %j outside the gateway grammar",
    (key) => {
      expect(single(`{"${key}":"b","ok":"c"}`)).toEqual({
        arguments: { ok: "c" },
        callId: "call-1",
        name: "grep",
        type: "tool-call",
        repair: {
          causes: ["malformed-arguments"],
          rawName: "grep",
          rawArguments: `{"${key}":"b","ok":"c"}`,
        },
      });
    },
  );

  it("keeps an argument name at the grammar limit", () => {
    expect(single(`{"${"k".repeat(128)}":"b"}`)).not.toHaveProperty("repair");
  });

  it("bounds the raw arguments kept for diagnosis", () => {
    const text = `{"pattern":${"9".repeat(5_000)}}`;
    const event = single(text);
    expect(event?.type === "tool-call" ? event.repair?.rawArguments : null).toBe(
      text.slice(0, 4_096),
    );
  });

  it("generates a deterministic call id from the response and index when one is missing", () => {
    const first = finish({ arguments: "{}", index: 3, name: "grep" });
    const again = finish({ arguments: "{}", index: 3, name: "grep" });
    const other = new ToolCallAccumulator("request:other");
    other.add([{ arguments: "{}", index: 3, name: "grep" }]);
    const id = first[0]?.type === "tool-call" ? first[0].callId : "";
    expect(id).toBe("call-bf049563-3");
    expect(again[0]).toMatchObject({ callId: id, repair: { causes: ["missing-id"] } });
    expect(other.finish()[0]).not.toMatchObject({ callId: id });
    const padded = new ToolCallAccumulator("request:0");
    padded.add([{ arguments: "{}", index: 0, name: "grep" }]);
    expect(padded.finish()[0]).toMatchObject({ callId: "call-0f58d1f8-0" });
    expect(finish({ arguments: "{}", id: "", index: 0, name: "grep" })[0]).toMatchObject({
      repair: { causes: ["missing-id"] },
    });
  });

  it("replaces a call id outside the gateway grammar", () => {
    const event = single("{}", "grep", "-bad id");
    expect(event).toMatchObject({ repair: { causes: ["invalid-id"] } });
    expect(event?.type === "tool-call" ? event.callId : "").toMatch(/^call-[0-9a-f]{8}-0$/u);
  });

  it("names a call without a valid tool name unknown_tool so the agent lists the tools", () => {
    expect(finish({ arguments: "{}", id: "call-1", index: 0 })[0]).toMatchObject({
      name: UNKNOWN_TOOL_NAME,
      repair: { causes: ["missing-name"], rawName: null },
    });
    expect(single("{}", "")).toMatchObject({
      name: UNKNOWN_TOOL_NAME,
      repair: { causes: ["missing-name"], rawName: "" },
    });
    expect(single("{}", "Grep")).toMatchObject({
      name: UNKNOWN_TOOL_NAME,
      repair: { causes: ["invalid-name"], rawName: "Grep" },
    });
    expect(UNKNOWN_TOOL_NAME).toBe("unknown_tool");
  });

  it("accepts a name and id that only arrive in a later fragment", () => {
    expect(
      finish(
        { arguments: '{"pattern":', index: 0 },
        { arguments: '"x"}', id: "call-late", index: 0, name: "grep" },
      ),
    ).toEqual([
      { arguments: { pattern: "x" }, callId: "call-late", name: "grep", type: "tool-call" },
    ]);
  });

  it("reports every cause of one call once, in order", () => {
    expect(finish({ arguments: '{"a":1,"b":2', index: 0 })[0]).toMatchObject({
      repair: { causes: ["missing-name", "missing-id", "malformed-arguments"] },
    });
    expect(finish({ arguments: '{"a":1,"b":2}', index: 0, name: "grep" })[0]).toMatchObject({
      repair: { causes: ["missing-id", "non-string-argument"] },
    });
  });
});
