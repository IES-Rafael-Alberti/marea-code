import { afterEach, expect, it, vi } from "vitest";
import { localTime } from "./local-time.js";
afterEach(() => {
  vi.restoreAllMocks();
});
it("shifts an instant into the viewer's zone and keeps minutes only", () => {
  const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
  expect(localTime(Date.parse("2026-01-01T12:34:56.789Z"))).toBe("2026-01-01T14:34");
  offset.mockReturnValue(90);
  expect(localTime(Date.parse("2026-01-01T00:10:00.000Z"))).toBe("2025-12-31T22:40");
});
