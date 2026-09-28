import { describe, expect, it } from "vitest";

import { runNonInteractiveSmoke, SMOKE_OUTPUT } from "./smoke.js";

describe("runNonInteractiveSmoke", () => {
  it("exercises streaming without a real terminal", () => {
    expect(runNonInteractiveSmoke()).toBe(`${SMOKE_OUTPUT}: complete/ok`);
  });
});
