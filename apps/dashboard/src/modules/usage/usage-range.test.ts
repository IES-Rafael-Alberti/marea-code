import { expect, it } from "vitest";
import { MAX_USAGE_WINDOW_MS, defaultUsageRange, usageWindow } from "./usage-range.js";

// Expectations derive from local dates, so the suite holds in any runner timezone.
const local = (year: number, month: number, date: number) => new Date(year, month - 1, date);

it("converts inclusive local days to an exclusive UTC window of millisecond precision", () => {
  expect(usageWindow({ from: "2026-09-01", to: "2026-09-07" })).toEqual({
    from: local(2026, 9, 1).toISOString(),
    until: local(2026, 9, 8).toISOString(),
  });
  expect(usageWindow({ from: "2026-09-26", to: "2026-09-26" })).toEqual({
    from: local(2026, 9, 26).toISOString(),
    until: local(2026, 9, 27).toISOString(),
  });
  expect(usageWindow({ from: "2026-12-31", to: "2026-12-31" })?.until).toBe(
    local(2027, 1, 1).toISOString(),
  );
  expect(usageWindow({ from: "2026-09-01", to: "2026-09-07" })?.from).toHaveLength(24);
});

it("accepts at most 31 days of real elapsed time and refuses reversed windows", () => {
  for (const [from, to, start, end] of [
    ["2026-01-01", "2026-01-31", local(2026, 1, 1), local(2026, 2, 1)],
    ["2026-10-01", "2026-10-31", local(2026, 10, 1), local(2026, 11, 1)],
    ["2026-03-01", "2026-03-31", local(2026, 3, 1), local(2026, 4, 1)],
    ["2026-01-01", "2026-02-01", local(2026, 1, 1), local(2026, 2, 2)],
  ] as const) {
    const span = end.getTime() - start.getTime();
    expect(usageWindow({ from, to }) !== undefined).toBe(span <= MAX_USAGE_WINDOW_MS);
  }
  expect(MAX_USAGE_WINDOW_MS).toBe(31 * 24 * 60 * 60 * 1000);
  expect(usageWindow({ from: "2026-01-01", to: "2026-02-01" })).toBeUndefined();
  expect(usageWindow({ from: "2026-02-01", to: "2026-02-28" })).toBeDefined();
  expect(usageWindow({ from: "2026-01-02", to: "2026-01-01" })).toBeUndefined();
});

it("refuses malformed and impossible calendar days on either side", () => {
  // Each counterpart is valid and near, so only the malformed day can cause refusal.
  for (const day of [
    "",
    "2026-2-28",
    "2026-02-8",
    "226-02-28",
    "20260-02-28",
    "x2026-02-28",
    "2026-02-28x",
    "2026-0x-28",
    "2026-02-2x",
    "2x26-02-28",
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "0050-02-28",
  ]) {
    expect(usageWindow({ from: day, to: "2026-03-05" })).toBeUndefined();
    expect(usageWindow({ from: "2026-02-20", to: day })).toBeUndefined();
  }
  // Overflowing values that would otherwise normalize to a valid nearby window.
  for (const range of [
    { from: "2026-13-01", to: "2027-01-05" },
    { from: "2026-12-20", to: "2026-13-01" },
    { from: "2026-00-10", to: "2025-12-20" },
    { from: "2025-12-05", to: "2026-00-10" },
    { from: "0050-02-28", to: "1950-03-05" },
    { from: "1950-02-25", to: "0050-02-28" },
    { from: "2026-02-30", to: "2026-03-05" },
    { from: "2026-02-25", to: "2026-02-30" },
  ])
    expect(usageWindow(range)).toBeUndefined();
  expect(usageWindow({ from: "2026-02-28", to: "2026-03-05" })).toBeDefined();
  expect(usageWindow({ from: "1950-02-25", to: "1950-02-28" })).toBeDefined();
  expect(usageWindow({ from: "2028-02-29", to: "2028-03-01" })).toBeDefined();
  expect(usageWindow({ from: "2026-04-30", to: "2026-05-01" })).toBeDefined();
});

it("defaults to the last seven local days including today", () => {
  expect(defaultUsageRange(new Date(2026, 8, 26, 23, 59))).toEqual({
    from: "2026-09-20",
    to: "2026-09-26",
  });
  expect(defaultUsageRange(new Date(2026, 0, 3, 0, 0))).toEqual({
    from: "2025-12-28",
    to: "2026-01-03",
  });
});
