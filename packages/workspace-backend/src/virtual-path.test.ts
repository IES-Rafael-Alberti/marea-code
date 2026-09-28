import { describe, expect, it, vi } from "vitest";

import { WorkspaceError, type WorkspaceOperation } from "./contracts.js";
import { appendVirtualPath, parseVirtualPath } from "./virtual-path.js";

const OPERATION: WorkspaceOperation = "read";

describe("virtual workspace paths", () => {
  it.each([
    ["/", []],
    ["/src", ["src"]],
    ["/src/main.ts", ["src", "main.ts"]],
    ["/área/😀.ts", ["área", "😀.ts"]],
    ["/.hidden", [".hidden"]],
    ["/..hidden", ["..hidden"]],
    ["/xcon", ["xcon"]],
    ["/conx", ["conx"]],
    ["/com0", ["com0"]],
    ["/com10", ["com10"]],
    ["/lpt0", ["lpt0"]],
    ["/lpt10", ["lpt10"]],
    ["/auxiliary", ["auxiliary"]],
    ["/prn-file", ["prn-file"]],
    ["/has space/name", ["has space", "name"]],
    ["/.marea", [".marea"]],
    ["/.mare-a", [".mare-a"]],
  ])("parses canonical POSIX path %s", (value, segments) => {
    expect(parseVirtualPath(value, OPERATION)).toEqual({ value, segments });
  });

  it.each([
    "",
    "relative/file.ts",
    "//server/share",
    "/trailing/",
    "/repeated//separator",
    "/.",
    "/..",
    "/src/../secret",
    "/src/./file",
    "/src\\file",
    "/file.txt:stream",
    "/directory/file:stream:$DATA",
    "C:/Windows/System32",
    "/C:/Windows/System32",
    "\\\\server\\share",
    "\\\\?\\C:\\secret",
    "/has\0nul",
    "/has\nnewline",
    "/has\u007fdelete",
    "/   ",
    "/name.",
    "/.name.",
    "/name ",
    "/CON",
    "/aux",
    "/PRN",
    "/nul.txt",
    "/directory/con.txt",
    "/com1.log",
    "/COM9",
    "/lpt1",
    "/LPT9",
    "/.marea-private.tmp",
    "/src/.MAREA-private.tmp",
  ])("rejects ambiguous or platform-native path %j", (value) => {
    expect(() => parseVirtualPath(value, OPERATION)).toThrow(
      new WorkspaceError("invalid-path", OPERATION),
    );
  });

  it("rejects a path larger than the virtual-path byte limit", () => {
    expect(() => parseVirtualPath(`/${"á".repeat(2_048)}`, OPERATION)).toThrow(
      new WorkspaceError("invalid-path", OPERATION),
    );
    expect(parseVirtualPath(`/${"a".repeat(4_095)}`, OPERATION).segments).toHaveLength(1);
  });

  it("rejects an oversized UTF-16 input before allocating UTF-8 output", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    try {
      expect(() => parseVirtualPath(`/${"a".repeat(100_000)}`, OPERATION)).toThrow(
        new WorkspaceError("invalid-path", OPERATION),
      );
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("appends discovered names without losing virtual semantics", () => {
    expect(appendVirtualPath(parseVirtualPath("/src", "list"), "main.ts")).toEqual({
      value: "/src/main.ts",
      segments: ["src", "main.ts"],
    });
    expect(appendVirtualPath(parseVirtualPath("/", "list"), "README.md")).toEqual({
      value: "/README.md",
      segments: ["README.md"],
    });
  });
});
