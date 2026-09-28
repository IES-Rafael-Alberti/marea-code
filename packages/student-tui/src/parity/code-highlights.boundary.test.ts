import hljs from "highlight.js";
import { expect, it, vi } from "vitest";
import { highlightCode } from "./code-highlights.boundary.js";

it("matches the captured Python token palette without changing source text", () => {
  const code =
    "def media(valores):\n    if not valores:\n        return 0\n    return sum(valores) / len(valores)";
  const parts = highlightCode(code, "python");
  expect(parts.map((part) => part.text).join("")).toBe(code);
  expect(parts.filter((part) => part.text.trim() !== "")).toEqual([
    { text: "def", fg: "#ffc473", attributes: 0 },
    { text: "media", fg: "#ffc473", attributes: 8 },
    { text: "(", fg: "#ffffff", attributes: 0 },
    { text: "valores", fg: "#57a5e2", attributes: 0 },
    { text: "):\n    ", fg: "#ffffff", attributes: 0 },
    { text: "if", fg: "#ffc473", attributes: 0 },
    { text: "not", fg: "#d17e92", attributes: 1 },
    { text: "valores", fg: "#57a5e2", attributes: 0 },
    { text: ":\n        ", fg: "#ffffff", attributes: 0 },
    { text: "return", fg: "#ffc473", attributes: 0 },
    { text: "0", fg: "#ffc473", attributes: 0 },
    { text: "return", fg: "#ffc473", attributes: 0 },
    { text: "sum", fg: "#ffc473", attributes: 0 },
    { text: "(", fg: "#ffffff", attributes: 0 },
    { text: "valores", fg: "#57a5e2", attributes: 0 },
    { text: ") ", fg: "#ffffff", attributes: 0 },
    { text: "/", fg: "#ffffff", attributes: 1 },
    { text: "len", fg: "#ffc473", attributes: 0 },
    { text: "(", fg: "#ffffff", attributes: 0 },
    { text: "valores", fg: "#57a5e2", attributes: 0 },
    { text: ")", fg: "#ffffff", attributes: 0 },
  ]);
});
it.each(["python", "py", "javascript", "typescript", "html", "unknown-language", ""])(
  "preserves literal tags, quotes and entities in %s",
  (language) => {
    const text = "# comment\nclass Example:\n  value = \"<span>&amp; 'é' >\"\n";
    expect(
      highlightCode(text, language)
        .map((part) => part.text)
        .join(""),
    ).toBe(text);
  },
);
it("styles classes, comments, strings and word operators", () => {
  const parts = highlightCode(
    "class Example:\n    # note\n    value = 'yes'\n    a and b or c in d is not e",
    "py",
  );
  expect(parts).toContainEqual({ text: "Example", fg: "#ffc473", attributes: 8 });
  expect(parts).toContainEqual({ text: "# note", fg: "#777777", attributes: 4 });
  expect(parts).toContainEqual({ text: "'yes'", fg: "#74be9b", attributes: 0 });
  for (const text of ["and", "or", "in", "is", "not"])
    expect(parts).toContainEqual({ text, fg: "#d17e92", attributes: 1 });
});
it("renders unnamed or unknown fences as plain text, including empty blocks", () => {
  expect(highlightCode("", "")).toEqual([{ text: "", fg: "#ffffff", attributes: 0 }]);
  expect(highlightCode("<script>&", "unknown")).toEqual([
    { text: "<script>&", fg: "#ffffff", attributes: 0 },
  ]);
  expect(highlightCode("", "python")).toEqual([]);
});

it("keeps aliases, multi-character operators and non-Python identifiers distinct", () => {
  const text = "_Value += 2 == Other";
  const python = highlightCode(text, "python");
  expect(highlightCode(text, "py")).toEqual(python);
  expect(python).toContainEqual({ text: "+=", fg: "#ffffff", attributes: 1 });
  expect(python).toContainEqual({ text: "==", fg: "#ffffff", attributes: 1 });
  expect(highlightCode("identifier", "javascript")).toEqual([
    { text: "identifier", fg: "#ffffff", attributes: 0 },
  ]);
  expect(highlightCode("function is() {}", "javascript")).toContainEqual({
    text: "is",
    fg: "#ffc473",
    attributes: 8,
  });
});
it("asks the highlighter to preserve text with illegal syntax", () => {
  const spy = vi.spyOn(hljs, "highlight");
  try {
    highlightCode("$ illegal", "python");
    expect(spy).toHaveBeenCalledExactlyOnceWith("$ illegal", {
      language: "python",
      ignoreIllegals: true,
    });
  } finally {
    spy.mockRestore();
  }
});
