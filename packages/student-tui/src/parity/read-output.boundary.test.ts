import { expect, it } from "vitest";
import { readableToolResult } from "./read-output.boundary.js";
const page = { content: "first\nsecond", offset: 0, nextOffset: null, totalLength: 12 };
it.each(["marea_read_skill", "marea_read_project"])("decodes %s pages exactly once", (name) => {
  expect(readableToolResult(name, JSON.stringify(page))).toBe(page.content);
  const text = JSON.stringify(page);
  expect(readableToolResult(name, JSON.stringify({ ...page, content: text, nextOffset: 5 }))).toBe(
    text,
  );
});
it("formats complete directory JSON but retains truncated directory pages", () => {
  expect(
    readableToolResult(
      "marea_list_project",
      JSON.stringify({ ...page, content: '[{"path":"/main.ts"}]' }),
    ),
  ).toBe('[\n  {\n    "path": "/main.ts"\n  }\n]');
  expect(
    readableToolResult("marea_list_project", JSON.stringify({ ...page, content: '[{"path":' })),
  ).toBe('[{"path":');
});
it("does not reinterpret non-read results or malformed envelopes", () => {
  expect(readableToolResult("write_file", JSON.stringify(page))).toBe(JSON.stringify(page));
  for (const value of [
    "oops",
    "null",
    "[]",
    "1",
    JSON.stringify({ content: 1 }),
    ...["content", "offset", "totalLength", "nextOffset"].flatMap((key) => [
      JSON.stringify({ ...page, [key]: undefined }),
      JSON.stringify({ ...page, [key]: {} }),
    ]),
  ])
    expect(readableToolResult("marea_read_skill", value)).toBe(value);
});
