import { describe, expect, it } from "vitest";

import { chunkShape, safeCode } from "./chunk-shape.boundary.js";
import { parseOpenRouterData } from "./openrouter-http.boundary.js";

describe("unreadable chunk diagnostics", () => {
  it("describes structure and types without any value", () => {
    expect(
      chunkShape(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: 7, reasoning: "secret words" } }],
          "odd key!": null,
          list: [],
          flag: true,
        }),
      ),
    ).toBe(
      "{choices:[{index:number,delta:{content:number,reasoning:string}}],odd?key?:null,list:[],flag:boolean}",
    );
    expect(chunkShape("12")).toBe("number");
    expect(chunkShape('{"a":{"b":{"c":{"d":{"e":1}}}}}')).toBe("{a:{b:{c:{d:…}}}}");
    expect(chunkShape('{"a":[[[[1]]]]}')).toBe("{a:[[[…]]]}");
    expect(chunkShape(`{"${"k".repeat(40)}":1}`)).toBe(`{${"k".repeat(32)}:number}`);
    expect(chunkShape("{data: private")).toBe("not JSON, 14 characters");
  });

  it("bounds a long shape", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`key${String(index)}`, 1]),
    );
    const shape = chunkShape(JSON.stringify(wide));
    expect(shape).toHaveLength(256);
    expect(shape.endsWith("…")).toBe(true);
    const exact = chunkShape(JSON.stringify({ ["a".repeat(32)]: "x".repeat(5) }));
    expect(exact).toBe(`{${"a".repeat(32)}:string}`);
    // A shape of exactly the bound is kept whole.
    const entries: [string, number][] = Array.from({ length: 6 }, (_, index) => [
      `${"a".repeat(31)}${String(index)}`,
      1,
    ]);
    const bounded = Object.fromEntries([...entries, ["b".repeat(7), 1]]);
    expect(chunkShape(JSON.stringify(bounded))).toHaveLength(256);
    expect(chunkShape(JSON.stringify(bounded)).endsWith("number}")).toBe(true);
  });

  it("keeps only safe characters of a provider error code", () => {
    expect(safeCode("server_error")).toBe("server_error");
    expect(safeCode(429)).toBe("429");
    expect(safeCode("bad code: <private>")).toBe("badcodeprivate");
    expect(safeCode("x".repeat(40))).toBe("x".repeat(32));
    expect(safeCode("!!")).toBe("unknown");
    expect(safeCode({ code: 1 })).toBe("unknown");
    expect(safeCode(undefined)).toBe("unknown");
  });

  it("names the shape of a chunk whose choices cannot be read", () => {
    expect(() => parseOpenRouterData('{"choices":"private"}')).toThrow(
      expect.objectContaining({
        code: "invalid-response",
        message: "The inference provider returned an invalid stream chunk ({choices:string}).",
      }),
    );
    expect(parseOpenRouterData('{"error":{"code":"x"},"choices":[]}').errorCode).toBe("x");
    expect(parseOpenRouterData('{"choices":[]}')).not.toHaveProperty("errorCode");
  });
});
