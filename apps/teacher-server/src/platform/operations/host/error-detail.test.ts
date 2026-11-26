import { describe, expect, it } from "vitest";

import { describeError } from "./error-detail.js";

describe("describeError", () => {
  it("names the error, its code and its message", () => {
    expect(describeError(Object.assign(new Error("occupied"), { code: "EEXIST" }))).toBe(
      "Error EEXIST: occupied",
    );
    expect(describeError(new RangeError("synthetic"))).toBe("RangeError: synthetic");
  });

  it("omits the message on request, because a parser may quote rejected text", () => {
    expect(describeError(new SyntaxError("unexpected token sk-synthetic"), false)).toBe(
      "SyntaxError",
    );
    expect(describeError(Object.assign(new Error("x"), { code: "ENOENT" }), false)).toBe(
      "Error ENOENT",
    );
  });

  it("ignores a non-string code, an empty message and a non-error value", () => {
    expect(describeError(Object.assign(new Error(""), { code: 5 }))).toBe("Error");
    expect(describeError("text")).toBe("string");
  });

  it("bounds the description", () => {
    expect(describeError(new Error("x".repeat(1000)))).toHaveLength(300);
  });
});
