import { describe, expect, it } from "vitest";

import { BundledSkillError } from "./errors.js";
import { bundledSkillId, isValidSkillName, parseSkillId } from "./skill-source.js";

describe("skill identifiers", () => {
  it.each(["testing", "skill-2", "2fa-testing", "a".repeat(64)])(
    "accepts the portable Marea name %s",
    (name) => {
      expect(isValidSkillName(name)).toBe(true);
      expect(bundledSkillId(name)).toBe(`marea/${name}`);
    },
  );

  it.each([
    "",
    "a".repeat(65),
    "-testing",
    "testing-",
    "test--suite",
    "Test",
    "café",
    "工具2",
    "test_suite",
    "test/slash",
  ])("rejects the invalid name %s", (name) => {
    expect(isValidSkillName(name)).toBe(false);
  });

  it.each(["marea/testing", "teacher/t-1/api-testing", "center/center-1/testing"])(
    "parses the protocol SkillId provenance form %s",
    (id) => {
      expect(parseSkillId(id)).toBe(id);
    },
  );

  it("rejects malformed protocol skill identifiers", () => {
    expect(parseSkillId("teacher/testing")).toBeNull();
    expect(parseSkillId("marea/Test")).toBeNull();
  });

  it("refuses to create an identifier from an invalid name", () => {
    expect(() => bundledSkillId("Test")).toThrow(new TypeError("Invalid bundled skill name: Test"));
  });
});

describe("BundledSkillError", () => {
  it("retains its actionable machine-readable context", () => {
    const error = new BundledSkillError(
      "MISSING_SKILL_FILE",
      "didactic/testing/SKILL.md",
      "Add SKILL.md.",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "BundledSkillError",
      code: "MISSING_SKILL_FILE",
      location: "didactic/testing/SKILL.md",
      message: "Add SKILL.md.",
    });
  });
});
