import { describe, expect, it } from "vitest";

import { createSystemIdSource } from "./platform.boundary.js";

describe("system attempt identities", () => {
  it("namespaces each independently generated conversation attempt", () => {
    const ids = createSystemIdSource();
    const first = ids.attempt();
    expect(first).toMatch(/^attempt:[0-9a-f-]{36}$/u);
    expect(ids.attempt()).not.toBe(first);
  });
});
