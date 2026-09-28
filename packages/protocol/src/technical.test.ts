import { describe, expect, it } from "vitest";

import {
  RevisionIdSchema,
  SafeDisplayNameSchema,
  SoftwareVersionSchema,
  ToolNameSchema,
} from "./technical.js";

describe("technical identifiers", () => {
  it.each([
    "0.0.0",
    "12.34.56",
    "1.2.3-alpha.beta.gamma",
    "1.2.3+build.123.extra",
    "1.2.3-alpha.1+build.5",
  ])("accepts software version %s", (version) => {
    expect(SoftwareVersionSchema.parse(version)).toBe(version);
  });

  it.each([
    "v1.2.3",
    "1.2.3-tail!",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-",
    "1.2.3-alpha..beta",
    "1.2.3+",
    "1.2.3+build..extra",
  ])("rejects malformed software version %s", (version) => {
    expect(() => SoftwareVersionSchema.parse(version)).toThrow();
  });

  it("enforces the software-version length boundary", () => {
    const maximum = `1.0.0+${"a".repeat(58)}`;

    expect(SoftwareVersionSchema.parse(maximum)).toBe(maximum);
    expect(() => SoftwareVersionSchema.parse(`${maximum}a`)).toThrow();
  });

  it("accepts transport-safe revision and tool names", () => {
    expect(RevisionIdSchema.parse("revision:1_alpha.beta")).toBe("revision:1_alpha.beta");
    expect(ToolNameSchema.parse("write_file.v2-alpha")).toBe("write_file.v2-alpha");
  });

  it.each(["", " revision", "revision\nforged"])("rejects unsafe revision ID %s", (value) => {
    expect(() => RevisionIdSchema.parse(value)).toThrow();
  });

  it.each(["", "WriteFile", "write/file", "write file"])("rejects unsafe tool name %s", (value) => {
    expect(() => ToolNameSchema.parse(value)).toThrow();
  });

  it("normalizes and bounds safe display names", () => {
    expect(SafeDisplayNameSchema.parse("  Ana María  ")).toBe("Ana María");
    expect(SafeDisplayNameSchema.parse("a".repeat(120))).toHaveLength(120);
    expect(() => SafeDisplayNameSchema.parse("")).toThrow();
    expect(() => SafeDisplayNameSchema.parse("a".repeat(121))).toThrow();
  });

  it.each(["/private", "../private", "Ana_name", "Ana\nforged", "\u202esecret"])(
    "rejects unsafe display name %s",
    (value) => {
      expect(() => SafeDisplayNameSchema.parse(value)).toThrow();
    },
  );
});
