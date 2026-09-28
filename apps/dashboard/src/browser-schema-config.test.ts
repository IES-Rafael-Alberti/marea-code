import { expect, it } from "vitest";
import { config } from "zod";

it("disables schema JIT before the browser imports protocol schemas", async () => {
  config({ jitless: false });
  await import("./browser-schema-config.js");
  expect(config().jitless).toBe(true);
});
