import { describe, expect, it } from "vitest";
import { PrivateFilesystemError, privateFilesystemError } from "./private-filesystem-error.js";

describe("PrivateFilesystemError", () => {
  it("keeps a caller-chosen message and a valid diagnostic code", () => {
    const error = new PrivateFilesystemError("private-fs.timeout", "keep me");
    expect(error).toBeInstanceOf(Error);
    expect(error.diagnosticCode).toBe("private-fs.timeout");
    expect(error.message).toBe("keep me");
    expect(error.name).toBe("PrivateFilesystemError");
  });

  it("defaults to the secure message when none is provided", () => {
    const error = privateFilesystemError("timeout");
    expect(error.diagnosticCode).toBe("private-fs.timeout");
    expect(error.message).toBe("Private filesystem permissions could not be established.");
  });

  it("rejects diagnostic codes that do not match the shared contract", () => {
    expect(() => new PrivateFilesystemError("Private Fs!")).toThrow(
      "Invalid private filesystem diagnostic code.",
    );
  });
});
