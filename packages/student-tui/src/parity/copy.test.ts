import { describe, expect, it } from "vitest";

import { fill } from "./copy.js";

describe("fill", () => {
  it("replaces a named placeholder", () => {
    expect(fill("Pregunta {{index}} de {{total}}", { index: 2, total: 3 })).toBe("Pregunta 2 de 3");
  });

  it("leaves a placeholder the caller did not supply", () => {
    expect(fill("{{count}} líneas", {})).toBe("{{count}} líneas");
  });

  it("does not resolve an inherited property name", () => {
    expect(fill("{{toString}}", {})).toBe("{{toString}}");
  });

  it("returns a template without placeholders unchanged", () => {
    expect(fill("listo", { count: 1 })).toBe("listo");
  });
});
