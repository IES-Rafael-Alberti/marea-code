import { expect, it } from "vitest";

import { MAX_JSON_REQUEST_BYTES } from "./index.js";
import { MAX_RUN_EVENTS_REQUEST_BYTES } from "./events.js";

it("shares one 64 KiB plain JSON limit that stays below the explicit events limit", () => {
  expect(MAX_JSON_REQUEST_BYTES).toBe(65_536);
  expect(MAX_JSON_REQUEST_BYTES).toBeLessThan(MAX_RUN_EVENTS_REQUEST_BYTES);
});
