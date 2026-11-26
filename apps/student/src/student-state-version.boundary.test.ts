import { describe, expect, it } from "vitest";
import * as z from "zod";

import {
  assertStateVersionNotNewer,
  refuseUnknownFields,
  StudentStateNewerVersionError,
} from "./student-state-version.boundary.js";

describe("student state version guard", () => {
  it("refuses only a version above the supported one", () => {
    expect(() => {
      assertStateVersionNotNewer(3, 2);
    }).toThrow(StudentStateNewerVersionError);
    expect(() => {
      assertStateVersionNotNewer(2, 2);
    }).not.toThrow();
    expect(() => {
      assertStateVersionNotNewer(1, 2);
    }).not.toThrow();
    expect(() => {
      assertStateVersionNotNewer("3", 2);
    }).not.toThrow();
  });

  it("carries a printable diagnostic code, name and message", () => {
    expect(new StudentStateNewerVersionError()).toMatchObject({
      diagnosticCode: "local-state.newer-version",
      message: "The student state was written by a newer version of Marea.",
      name: "StudentStateNewerVersionError",
    });
  });

  it("recognizes a state that is only too new by its unrecognized fields", () => {
    const strict = z.object({ a: z.string() }).strict();
    const unknownOnly = strict.safeParse({ a: "x", b: 1 }).error;
    const mixed = strict.safeParse({ a: 1, b: 1 }).error;
    const wrong = strict.safeParse({ a: 1 }).error;

    expect(refuseUnknownFields(unknownOnly)).toBeInstanceOf(StudentStateNewerVersionError);
    expect(refuseUnknownFields(mixed)).toBe(mixed);
    expect(refuseUnknownFields(wrong)).toBe(wrong);
    const other = new Error("other");
    expect(refuseUnknownFields(other)).toBe(other);
    const empty = new z.ZodError([]);
    expect(refuseUnknownFields(empty)).toBe(empty);
  });
});
