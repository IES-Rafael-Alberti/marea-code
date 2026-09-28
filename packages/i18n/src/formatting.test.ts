import { expect, it } from "vitest";

import { formatDate, formatDateTime, formatNumber } from "./formatting.js";
import { createTranslator } from "./translator.js";

it("formats dates with both the requested date and time styles", () => {
  const date = new Date("2026-09-21T12:34:00Z");
  const expected = new Intl.DateTimeFormat("eu", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  expect(formatDateTime("eu", date)).toBe(expected);
  expect(
    formatDate("en", date.getTime(), {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  ).toBe("12:34");
  expect(formatNumber("en", 1234.5, { style: "currency", currency: "EUR" })).toBe("€1,234.50");
});

it("interpolates numeric parameters including zero", () => {
  const translator = createTranslator("en");
  expect(translator.t("student.tui.question.progress", { index: 1, total: 3 })).toBe(
    "Question 1 of 3",
  );
  expect(translator.t("student.tui.status.detail", { seconds: 0 })).toBe("0s");
});
