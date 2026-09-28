import { describe, expect, it } from "vitest";

import { readToolPage } from "./read-tool-page.js";

describe("bounded model read results", () => {
  it("returns explicit lengths and a continuation offset without discarding text", () => {
    expect(readToolPage("", 0)).toBe('{"content":"","offset":0,"nextOffset":null,"totalLength":0}');
    expect(readToolPage("abc", 1)).toBe(
      '{"content":"bc","offset":1,"nextOffset":null,"totalLength":3}',
    );
    expect(readToolPage("abc", 3)).toBe(
      '{"content":"","offset":3,"nextOffset":null,"totalLength":3}',
    );
    expect(() => readToolPage("abc", 4)).toThrow("The read offset is past the end of the content.");
    const text = "x".repeat(8_191) + "😀" + "\u0000".repeat(8_192);
    expect(JSON.parse(readToolPage(text, 0))).toEqual({
      content: text.slice(0, 8_192),
      offset: 0,
      nextOffset: 8_192,
      totalLength: text.length,
    });
    const chunks = [0, 8_192, 16_384].map(
      (offset) => JSON.parse(readToolPage(text, offset)) as { content: string },
    );
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(text);
    expect(readToolPage("\u0000".repeat(8_192), 0).length).toBeLessThan(65_536);
    expect(JSON.parse(readToolPage("a".repeat(8_192), 0))).toEqual({
      content: "a".repeat(8_192),
      offset: 0,
      nextOffset: null,
      totalLength: 8_192,
    });
  });
});
