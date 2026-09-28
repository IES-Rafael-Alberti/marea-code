import * as z from "zod";
import { describe, expect, it } from "vitest";

import {
  rowBoolean,
  rowInteger,
  rowJson,
  rowNullableText,
  rowText,
} from "./row-parser.boundary.js";

describe("SQLite teacher row parsing boundary", () => {
  it("reads text, nullable text, safe integers, booleans, and validated JSON", () => {
    expect(rowText({ value: "text" }, "value")).toBe("text");
    expect(rowNullableText({ value: null }, "value")).toBeNull();
    expect(rowNullableText({ value: "text" }, "value")).toBe("text");
    expect(rowInteger({ value: 2n }, "value")).toBe(2);
    expect(rowInteger({ value: 3 }, "value")).toBe(3);
    expect(rowBoolean({ value: 0 }, "value")).toBe(false);
    expect(rowBoolean({ value: 1n }, "value")).toBe(true);
    expect(rowJson({ value: '{"safe":true}' }, "value", z.object({ safe: z.boolean() }))).toEqual({
      safe: true,
    });
  });

  it("rejects every malformed stored representation", () => {
    for (const operation of [
      () => rowText({ value: 1 }, "value"),
      () => rowNullableText({ value: 1 }, "value"),
      () => rowInteger({ value: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, "value"),
      () => rowInteger({ value: 1.5 }, "value"),
      () => rowInteger({ value: "1" }, "value"),
      () => rowBoolean({ value: 2 }, "value"),
    ]) {
      expect(operation).toThrow("Stored teacher data is invalid.");
    }
    expect(() => rowJson({ value: "{}" }, "value", z.object({ safe: z.boolean() }))).toThrow();
    expect(() => rowJson({ value: "{" }, "value", z.object({ safe: z.boolean() }))).toThrow();
  });
});
