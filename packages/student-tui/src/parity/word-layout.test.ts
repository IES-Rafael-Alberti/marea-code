import { expect, it } from "vitest";
import { fittingWords, wrapParts } from "./word-layout.js";
it.each([
  ["modelo-docente · main", 16, "modelo-docente ·"],
  ["modelo-docente", 13, ""],
  ["/help", 4, ""],
  ["one two", 3, "one"],
  ["one two", 4, "one"],
  ["one two", 7, "one two"],
  ["one two", 8, "one two"],
  ["x", -1, ""],
  ["", 0, ""],
  ["a   b", 3, "a"],
])("fits %s into %s columns without splitting a word", (text, width, expected) => {
  expect(fittingWords(text, width)).toBe(expected);
});

it("wraps styled command words without splitting slash labels or losing spacing", () => {
  expect(
    wrapParts(
      [
        { text: "/help", command: true },
        { text: "  help   ", command: false },
        { text: "/details", command: true },
        { text: "  more", command: false },
      ],
      15,
    ),
  ).toEqual([
    { text: "/help", command: true },
    { text: "  help", command: false },
    { text: "\n/details", command: true },
    { text: "  more", command: false },
  ]);
  expect(wrapParts([{ text: "ab cd", command: false }], 5)).toEqual([
    { text: "ab", command: false },
    { text: " cd", command: false },
  ]);
  expect(wrapParts([{ text: "/long", command: true }], 1)).toEqual([
    { text: "/long", command: true },
  ]);
  expect(wrapParts([], 1)).toEqual([]);
});

it("fits repeated spaces and trims an otherwise fitting boundary", () => {
  expect(fittingWords("one   two three", 8)).toBe("one");
  expect(fittingWords("abcd efgh", 5)).toBe("abcd");
  expect(wrapParts([{ text: "a   bb", command: true }], 5)).toEqual([
    { text: "a", command: true },
    { text: "\nbb", command: true },
  ]);
});
