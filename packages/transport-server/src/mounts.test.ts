import { describe, expect, it } from "vitest";

import { validateTransportMounts } from "./mounts.js";

describe("transport mounts", () => {
  it.each([
    [`/${"a".repeat(127)}`, "/b"],
    ["/stream/data", "/session/events"],
  ])("accepts distinct canonical static paths %#", (stream, session) => {
    expect(() => {
      validateTransportMounts(stream, session);
    }).not.toThrow();
  });

  it.each([
    "/",
    "stream",
    `/${"a".repeat(128)}`,
    "//stream",
    "/stream/",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/bad:path",
  ])("rejects a non-canonical stream path %#", (stream) => {
    expect(() => {
      validateTransportMounts(stream, "/session");
    }).toThrow("Transport mounts must be distinct static absolute paths.");
  });

  it("rejects an invalid or duplicate session path", () => {
    expect(() => {
      validateTransportMounts("/stream", "/bad path");
    }).toThrow("Transport mounts must be distinct static absolute paths.");
    expect(() => {
      validateTransportMounts("/stream", "/stream");
    }).toThrow("Transport mounts must be distinct static absolute paths.");
  });
});
