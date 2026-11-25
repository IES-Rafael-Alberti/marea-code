import { describe, expect, it } from "vitest";

import { toInternalToolName, toPublicToolName } from "./tool-names.js";

const publicNames = {
  marea_write_file: "write_file",
  marea_edit_file: "edit_file",
  marea_execute: "execute",
  marea_delete: "delete",
  marea_read_project: "read_file",
  marea_list_project: "ls",
  marea_glob_project: "glob",
  marea_search_project: "grep",
};

describe("tool names", () => {
  it("shows every Marea tool under its standard name and maps it back", () => {
    for (const [internal, external] of Object.entries(publicNames)) {
      expect(toPublicToolName(internal)).toBe(external);
      expect(toInternalToolName(external)).toBe(internal);
    }
  });

  it("keeps names Marea does not rename", () => {
    expect(toPublicToolName("write_todos")).toBe("write_todos");
    expect(toInternalToolName("write_todos")).toBe("write_todos");
  });
});
