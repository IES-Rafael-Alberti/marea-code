import { WorkspaceError, type WorkspaceErrorCode } from "@marea/workspace-backend";
import { expect, it } from "vitest";
import * as z from "zod";

import { modelFeedback, OperationRejectedError } from "./operation-feedback.boundary.js";
import { StaleReviewError, WorkspaceEffectError } from "./workspace-writer.js";

it("names its errors for diagnosis", () => {
  expect(new OperationRejectedError("x").name).toBe("OperationRejectedError");
  expect(new StaleReviewError().name).toBe("StaleReviewError");
});

it("passes on what the model got wrong in its own words", () => {
  expect(modelFeedback(new OperationRejectedError("Read the file again."))).toBe(
    "Read the file again.",
  );
  expect(modelFeedback(new StaleReviewError())).toBe("The file changed after review.");
});

it("lists the invalid arguments of a validation failure", () => {
  const parsed = z.object({ path: z.string(), nested: z.object({ a: z.string() }) }).safeParse({});
  if (parsed.success) throw new Error("Expected a failure.");
  expect(modelFeedback(parsed.error)).toBe(
    "The arguments are invalid: path: Invalid input: expected string, received undefined; nested: Invalid input: expected object, received undefined",
  );
});

it.each<WorkspaceErrorCode>([
  "invalid-path",
  "not-found",
  "already-exists",
  "not-directory",
  "directory-not-empty",
  "not-regular-file",
  "unsafe-entry",
  "read-limit-exceeded",
  "write-limit-exceeded",
  "edit-conflict",
  "unsupported-text-encoding",
])("tells the model about the workspace refusal %s", (code) => {
  expect(modelFeedback(new WorkspaceError(code, "read"))).toContain(`(${code})`);
});

it.each<WorkspaceErrorCode>(["filesystem-failure", "invalid-root", "invalid-limit"])(
  "leaves the machine's failure %s to fail the turn",
  (code) => {
    expect(modelFeedback(new WorkspaceError(code, "read"))).toBeNull();
  },
);

it("leaves any other failure to fail the turn", () => {
  expect(modelFeedback(new Error("disk full"))).toBeNull();
  expect(
    modelFeedback(new WorkspaceEffectError("The workspace changed while pending.")),
  ).toBeNull();
  expect(modelFeedback("text")).toBeNull();
});
