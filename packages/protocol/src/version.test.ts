import { describe, expect, it } from "vitest";

import {
  CurrentProtocolVersionSchema,
  isSupportedProtocolVersion,
  ProtocolVersionSchema,
  selectProtocolVersion,
} from "./version.js";

describe("protocol version", () => {
  it("recognizes only the current compatible version", () => {
    expect(isSupportedProtocolVersion("0.1")).toBe(true);
    expect(isSupportedProtocolVersion("2.0")).toBe(false);
  });

  it("distinguishes a well-formed version from the current version", () => {
    expect(ProtocolVersionSchema.parse("2.0")).toBe("2.0");
    expect(() => ProtocolVersionSchema.parse("next")).toThrow();
    expect(() => CurrentProtocolVersionSchema.parse("2.0")).toThrow();
  });

  it.each(["0.1", "12.345"])("accepts well-formed protocol version %s", (version) => {
    expect(ProtocolVersionSchema.parse(version)).toBe(version);
  });

  it.each(["v0.1", "0.1-next", "0.1x"])("rejects malformed protocol version %s", (version) => {
    expect(() => ProtocolVersionSchema.parse(version)).toThrow();
  });

  it("selects the first client-preferred common version", () => {
    const current = ProtocolVersionSchema.parse("0.1");
    const next = ProtocolVersionSchema.parse("1.0");
    const future = ProtocolVersionSchema.parse("2.0");

    expect(selectProtocolVersion([next, current], [current, next])).toBe("1.0");
    expect(selectProtocolVersion([current], [future])).toBeNull();
  });
});
