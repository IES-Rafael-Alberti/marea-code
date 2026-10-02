import { expect, it } from "vitest";
import { sessionTime } from "./session-time.js";

it("shows only the time for today's sessions and the day for older ones", () => {
  const now = new Date("2026-10-02T18:00:00Z");
  expect(sessionTime("2026-10-02T08:05:00Z", "es", now, "UTC")).toBe("08:05");
  expect(sessionTime("2026-09-08T08:05:00Z", "es", now, "UTC")).toBe("8 sept, 08:05");
  expect(sessionTime("2025-10-02T08:05:00Z", "es", now, "UTC")).toBe("2 oct, 08:05");
  expect(sessionTime("2026-09-08T08:05:00Z", "en", now, "UTC")).toBe("Sep 8, 08:05 AM");
  // The zone decides which day a late session belongs to.
  expect(sessionTime("2026-10-02T23:30:00Z", "es", now, "Europe/Madrid")).toBe("3 oct, 01:30");
  expect(typeof sessionTime("2026-10-02T08:05:00Z", "es")).toBe("string");
});
