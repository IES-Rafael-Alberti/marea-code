import { describe, expect, it } from "vitest";

import { WorkspaceError, type WorkspaceErrorCode } from "./contracts.js";

describe("workspace errors", () => {
  it.each([
    ["invalid-root", "The workspace root is invalid."],
    ["invalid-limit", "A workspace limit is invalid."],
    ["invalid-path", "The virtual workspace path is invalid."],
    ["not-found", "The workspace entry does not exist."],
    ["already-exists", "The workspace entry already exists."],
    ["not-directory", "The workspace entry is not a directory."],
    ["directory-not-empty", "The workspace directory is not empty."],
    ["not-regular-file", "The workspace entry is not a regular file."],
    ["unsafe-entry", "The workspace entry is not safe to access."],
    ["read-limit-exceeded", "The workspace read limit was exceeded."],
    ["write-limit-exceeded", "The workspace write limit was exceeded."],
    ["directory-limit-exceeded", "The workspace directory limit was exceeded."],
    ["edit-conflict", "The requested workspace edit cannot be applied."],
    ["unsupported-text-encoding", "The workspace file is not valid UTF-8 text."],
    ["filesystem-failure", "The workspace operation failed."],
  ] satisfies readonly (readonly [WorkspaceErrorCode, string])[])(
    "provides the fixed public message for %s",
    (code, message) => {
      const error = new WorkspaceError(code, "read");

      expect(error.name).toBe("WorkspaceError");
      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(error.operation).toBe("read");
    },
  );
});
