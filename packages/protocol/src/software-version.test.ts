import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_SOFTWARE_VERSION,
  SoftwareVersionSchema,
  softwareVersionsDiffer,
} from "./index.js";

describe("software version comparison", () => {
  it("is a valid wire version", () => {
    expect(SoftwareVersionSchema.parse(DEVELOPMENT_SOFTWARE_VERSION)).toBe("0.0.0-dev");
  });

  it.each([
    ["0.1.0-preview.49", "0.1.0-preview.49", false],
    ["0.1.0-preview.49", "0.1.0-preview.50", true],
    ["0.2.0", "0.1.0-preview.50", true],
    ["0.0.0-dev", "0.1.0-preview.50", false],
    ["0.1.0-preview.50", "0.0.0-dev", false],
    ["0.0.0-dev", "0.0.0-dev", false],
  ] as const)("%s and %s differ: %s", (first, second, expected) => {
    expect(softwareVersionsDiffer(first, second)).toBe(expected);
  });
});
