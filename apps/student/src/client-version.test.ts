import { describe, expect, it } from "vitest";

import { studentClientVersion } from "./client-version.js";
import { MAREA_CLIENT_VERSION } from "./marea-command.boundary.js";

describe("student client version", () => {
  it("reports the development version when no release version was injected", () => {
    expect(studentClientVersion()).toBe("0.0.0-dev");
    expect(MAREA_CLIENT_VERSION).toBe("0.0.0-dev");
  });

  it("reports the injected release version", () => {
    expect(studentClientVersion("0.1.0-preview.50")).toBe("0.1.0-preview.50");
  });

  it("refuses an injected value that is not a software version", () => {
    expect(() => studentClientVersion("preview 50")).toThrow();
  });
});
