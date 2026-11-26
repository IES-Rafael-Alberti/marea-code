import { expect, it } from "vitest";
import { appendNote, noteDate, recentLines } from "./notes-text.js";

it("dates notes as dd/mm/aaaa in the server's local day", () => {
  expect(noteDate("2026-09-07T12:00:00.000Z")).toBe("07/09/2026");
  expect(noteDate("2026-12-25T12:00:00.000Z")).toBe("25/12/2026");
  const local = new Date(2027, 0, 3, 0, 30).toISOString();
  expect(noteDate(local)).toBe("03/01/2027");
});

it("appends a line, starting a history when it is empty", () => {
  expect(appendNote("", "07/09/2026: First")).toBe("07/09/2026: First");
  expect(appendNote("07/09/2026: First", "08/09/2026: Second")).toBe(
    "07/09/2026: First\n08/09/2026: Second",
  );
});

it("keeps the newest whole lines whose JSON form fits the limit", () => {
  expect(recentLines("", 2)).toEqual({ text: "", omitted: 0 });
  expect(recentLines("a\nbb\nccc", 1000)).toEqual({ text: "a\nbb\nccc", omitted: 0 });
  // "bb\nccc" is "bb\\nccc" in JSON: 2 quotes + 3 + 2 + 2 = 9 bytes.
  expect(recentLines("a\nbb\nccc", 9)).toEqual({ text: "bb\nccc", omitted: 2 });
  expect(recentLines("a\nbb\nccc", 8)).toEqual({ text: "ccc", omitted: 5 });
  expect(recentLines("a\nbb\nccc", 5)).toEqual({ text: "ccc", omitted: 5 });
  expect(recentLines("a\nbb\nccc", 4)).toEqual({ text: "", omitted: 8 });
  // Escaped characters and multibyte text count with their encoded size.
  expect(recentLines('x\n"é"', 8)).toEqual({ text: '"é"', omitted: 2 });
  expect(recentLines('x\n"é"', 7)).toEqual({ text: "", omitted: 5 });
});
