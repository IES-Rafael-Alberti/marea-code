import { describe, expect, it } from "vitest";

import { toInternalToolName, toPublicToolName } from "./tool-names.js";

describe("tool names", () => {
  it.each([
    ["marea_write_file", "write_file"],
    ["marea_edit_file", "edit_file"],
    ["marea_execute", "execute"],
    ["marea_delete", "delete"],
  ])("shows %s as %s and maps it back", (internal, external) => {
    expect(toPublicToolName(internal)).toBe(external);
    expect(toInternalToolName(external)).toBe(internal);
  });

  it("keeps names Marea does not rename", () => {
    expect(toPublicToolName("read_file")).toBe("read_file");
    expect(toInternalToolName("read_file")).toBe("read_file");
  });
});
