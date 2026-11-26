import { AgentAdapterError, ModelStreamError } from "@marea/deepagents-adapter";
import { describe, expect, it } from "vitest";

import { NoActiveRunError, TurnAttemptFailed, type TurnFailureInfo } from "./contracts.js";
import { StudentHttpError } from "./http-error.js";
import { RequiredSkillsError } from "./required-skill-context.js";
import { failureCategory, failureDiagnostic } from "./turn-diagnostics.boundary.js";

const unexpected: TurnFailureInfo = {
  detail: "",
  hasPrefix: false,
  kind: "unexpected",
  recoverable: true,
  retryable: false,
};

function withCause(error: Error, cause: object): Error {
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}

describe("turn failure category", () => {
  it.each([
    [
      new ModelStreamError({ code: "invalid-response", message: "x", retryable: false }),
      "unexpected/provider.invalid-response",
    ],
    [
      withCause(
        new AgentAdapterError("upstream-execution-failed", "x"),
        new TypeError("bad input"),
      ),
      "unexpected/adapter.upstream-execution-failed/TypeError",
    ],
    [
      new AgentAdapterError("upstream-execution-failed", "x"),
      "unexpected/adapter.upstream-execution-failed",
    ],
    [
      new AgentAdapterError("upstream-contract-changed", "x"),
      "unexpected/adapter.upstream-contract-changed",
    ],
    [new NoActiveRunError("No run."), "unexpected/session.no-active-run"],
    [new RequiredSkillsError("missing"), "unexpected/skills.required"],
    [new RangeError("boom"), "unexpected/client.RangeError"],
    [
      withCause(
        new ModelStreamError({ code: "invalid-response", message: "x", retryable: false }),
        new TypeError("inner"),
      ),
      "unexpected/provider.invalid-response",
    ],
    [
      withCause(new AgentAdapterError("upstream-contract-changed", "x"), new TypeError("inner")),
      "unexpected/adapter.upstream-contract-changed",
    ],
    ["text", "unexpected/client.string"],
  ] as const)("names the origin of %s", (error, category) => {
    expect(failureCategory(new TurnAttemptFailed("", error as Error), unexpected)).toBe(category);
  });

  it("names a server refusal by its code and keeps the student-facing kind first", () => {
    const http = new StudentHttpError(500, "server.error", true);
    expect(
      failureCategory(withCause(new Error("wrapped"), http), {
        ...unexpected,
        kind: "request-failed",
      }),
    ).toBe("request-failed/http.server.error");
  });

  it("stays within the protocol limit", () => {
    const long = new Error("x");
    long.name = "N".repeat(300);
    expect(failureCategory(long, unexpected)).toHaveLength(128);
  });
});

describe("turn failure diagnostic", () => {
  it("records the exception, its cause chain and the deepest stack", () => {
    const root = new SyntaxError("Unexpected end of JSON input");
    const error = withCause(new AgentAdapterError("upstream-execution-failed", "wrapped"), root);
    const diagnostic = failureDiagnostic(new TurnAttemptFailed("partial", error));
    expect(diagnostic.exception).toEqual({ name: "AgentAdapterError", message: "wrapped" });
    expect(diagnostic.causes).toEqual([
      { name: "SyntaxError", message: "Unexpected end of JSON input" },
    ]);
    expect(diagnostic.stack).toBe(root.stack);
  });

  it("bounds every field and survives cycles, non-errors and missing stacks", () => {
    const looping = new Error("m".repeat(3_000));
    Object.defineProperty(looping, "cause", { value: looping });
    looping.stack = "s".repeat(10_000);
    const bounded = failureDiagnostic(looping);
    expect(bounded.exception.message).toHaveLength(2_048);
    expect(bounded.causes).toEqual([]);
    expect(bounded.stack).toHaveLength(8_192);
    const nameless = new Error("x");
    nameless.name = "";
    delete nameless.stack;
    expect(failureDiagnostic(nameless)).toEqual({
      exception: { name: "Error", message: "x" },
      causes: [],
      stack: "",
    });
    expect(failureDiagnostic(7)).toEqual({
      exception: { name: "number", message: "7" },
      causes: [],
      stack: "",
    });
    let chain: Error = new Error("0");
    for (let index = 1; index < 12; index += 1) chain = withCause(new Error(String(index)), chain);
    expect(failureDiagnostic(chain).causes).toHaveLength(8);
    const long = new Error("x");
    long.name = "N".repeat(300);
    expect(failureDiagnostic(long).exception.name).toHaveLength(128);
    expect(failureDiagnostic("t".repeat(3_000)).exception.message).toHaveLength(2_048);
  });
});

describe("model stream failure diagnostics", () => {
  it("records the gateway's code and message, bounded", () => {
    const short = new ModelStreamError({
      code: "invalid-response",
      message: "The inference provider returned an invalid stream chunk ({choices:string}).",
      retryable: false,
    });
    expect(failureDiagnostic(new TurnAttemptFailed("", short)).exception).toEqual({
      name: "ModelStreamError",
      message:
        "invalid-response: The inference provider returned an invalid stream chunk ({choices:string}).",
    });
    const long = new ModelStreamError({
      code: "unavailable",
      message: "m".repeat(3000),
      retryable: true,
    });
    expect(failureDiagnostic(new TurnAttemptFailed("", long)).exception.message).toHaveLength(2048);
  });
});
