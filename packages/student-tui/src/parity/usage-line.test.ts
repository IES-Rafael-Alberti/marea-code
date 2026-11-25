import { describe, expect, it } from "vitest";

import { compactTokens, usageLine } from "./usage-line.js";

describe("usage line", () => {
  it.each([
    [0, "0"],
    [21, "21"],
    [999, "999"],
    [1_000, "1k"],
    [2_449, "2.4k"],
    [9_999, "9.9k"],
    [10_000, "10k"],
    [262_144, "262k"],
    [999_999, "999k"],
    [1_000_000, "1M"],
    [1_250_000, "1.2M"],
    [12_000_000, "12M"],
  ])("writes %i tokens as %s", (count, text) => {
    expect(compactTokens(count)).toBe(text);
  });

  it("shows the session totals and the share of the window the latest call used", () => {
    expect(
      usageLine({
        inputTokens: 2_400,
        outputTokens: 21,
        lastInputTokens: 2_360,
        contextWindowTokens: 262_144,
      }),
    ).toBe("↑2.4k ↓21 0.9%/262k");
  });

  it("shows only the totals when the window is unknown", () => {
    expect(usageLine({ inputTokens: 5, outputTokens: 3, lastInputTokens: 5 })).toBe("↑5 ↓3");
  });
});
