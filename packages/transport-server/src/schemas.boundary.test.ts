import { describe, expect, it } from "vitest";

import { MAX_INPUT_CHARACTERS } from "./contracts.js";
import { parseClientFrame, parseStreamRequest } from "./schemas.boundary.js";

describe("transport schemas", () => {
  it("parses a client message", () => {
    expect(parseClientFrame('{"type":"message","messageId":"message_1","input":"Help"}')).toEqual({
      ok: true,
      value: { input: "Help", messageId: "message_1", type: "message" },
    });
  });

  it("parses a bounded stream request", () => {
    expect(
      parseStreamRequest(JSON.stringify({ input: "Explain this", streamId: "a".repeat(128) })),
    ).toEqual({
      ok: true,
      value: { input: "Explain this", streamId: "a".repeat(128) },
    });
    expect(
      parseStreamRequest(
        JSON.stringify({ input: "a".repeat(MAX_INPUT_CHARACTERS), streamId: "s" }),
      ),
    ).toEqual({
      ok: true,
      value: { input: "a".repeat(MAX_INPUT_CHARACTERS), streamId: "s" },
    });
  });

  it.each([
    "not-json",
    "{}",
    '{"input":"","streamId":"s"}',
    `{"input":"${"a".repeat(MAX_INPUT_CHARACTERS + 1)}","streamId":"s"}`,
    '{"input":"x","streamId":""}',
    `{"input":"x","streamId":"${"a".repeat(129)}"}`,
    '{"input":"x","streamId":"not valid"}',
    '{"input":"x","streamId":"s","extra":true}',
  ])("rejects invalid stream request %#", (body) => {
    expect(parseStreamRequest(body)).toEqual({ ok: false });
  });

  it.each([
    "not-json",
    "{}",
    '{"type":"message","messageId":"m","input":"","extra":true}',
    '{"type":"message","messageId":"","input":"x"}',
    '{"type":"other","messageId":"m","input":"x"}',
  ])("rejects invalid client frame %#", (body) => {
    expect(parseClientFrame(body)).toEqual({ ok: false });
  });
});
