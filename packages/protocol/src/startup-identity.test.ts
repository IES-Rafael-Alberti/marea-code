import { expect, it, vi } from "vitest";

it("initializes the reserved startup identity without a module-load failure", async () => {
  vi.resetModules();
  const protocol = await import("./runs.js");
  expect(protocol.STARTUP_MESSAGE_ID).toBe("marea:tutor-startup");
});
