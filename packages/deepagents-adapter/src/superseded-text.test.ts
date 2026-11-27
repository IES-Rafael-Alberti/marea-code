import { describe, expect, it } from "vitest";

import { commonPrefixLength, isKnownPrefix, realign } from "./superseded-text.js";

describe("superseded assistant text", () => {
  it("measures the shared start of two texts", () => {
    expect(commonPrefixLength("", "")).toBe(0);
    expect(commonPrefixLength("abc", "abc")).toBe(3);
    expect(commonPrefixLength("abcd", "abX")).toBe(2);
    expect(commonPrefixLength("ab", "abcd")).toBe(2);
    expect(commonPrefixLength("x", "y")).toBe(0);
  });

  it("knows a prefix of the durable text and of the text the caller was told to drop", () => {
    const superseded = { keptLength: 3, text: "old partial" };
    expect(isKnownPrefix("ok new", null, "ok ")).toBe(true);
    expect(isKnownPrefix("ok new", null, "ok old")).toBe(false);
    expect(isKnownPrefix("ok new", superseded, "ok old")).toBe(true);
    expect(isKnownPrefix("ok new", superseded, "ok old partial")).toBe(true);
    expect(isKnownPrefix("ok new", superseded, "ok old partial!")).toBe(false);
    expect(isKnownPrefix("ok new", superseded, "OK old")).toBe(false);
    // Only text after the kept part can be superseded.
    expect(isKnownPrefix("ok new", { keptLength: 3, text: "" }, "ok ")).toBe(true);
    expect(isKnownPrefix("abc", { keptLength: 3, text: "" }, "abd")).toBe(false);
    expect(isKnownPrefix("ab", { keptLength: 2, text: "c" }, "ac")).toBe(false);
  });

  it("realigns the caller by discarding only the text that differs", () => {
    expect(realign("kept old", "kept ")).toEqual({
      events: [{ type: "assistant-text-restarted", discardedLength: 3 }],
      superseded: { keptLength: 5, text: "old" },
    });
    expect(realign("ke", "kept ")).toEqual({
      events: [{ type: "assistant-text-delta", text: "pt " }],
      superseded: null,
    });
    expect(realign("kX", "kept")).toEqual({
      events: [
        { type: "assistant-text-restarted", discardedLength: 1 },
        { type: "assistant-text-delta", text: "ept" },
      ],
      superseded: { keptLength: 1, text: "X" },
    });
    expect(realign("same", "same")).toEqual({ events: [], superseded: null });
  });
});
