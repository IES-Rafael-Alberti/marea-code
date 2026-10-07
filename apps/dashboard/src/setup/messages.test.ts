import { expect, it, vi } from "vitest";
it("keeps every setup translation available when loaded by the standalone entry", async () => {
  vi.resetModules();
  const { setupMessages } = await import("./messages.js");
  expect((["es", "en", "eu"] as const).map((locale) => setupMessages(locale))).toMatchSnapshot();
});
