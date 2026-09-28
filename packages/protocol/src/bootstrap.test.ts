import { describe, expect, it } from "vitest";

import { ClassBootstrapRequestSchema, ClassBootstrapResponseSchema } from "./bootstrap.js";

const response = {
  kind: "class-bootstrapped",
  protocolVersion: "0.1",
  requestId: "request-bootstrap-1",
  principal: { role: "student", displayName: "Ana María" },
  classroom: { displayName: "Programming 1" },
  modelAlias: "marea",
  activeRun: {
    runId: "run-1",
    projectDisplayName: "Weather app",
    state: "active",
  },
} as const;

describe("class bootstrap protocol", () => {
  it("bootstraps the authenticated student's class and active run", () => {
    const request = ClassBootstrapRequestSchema.parse({
      kind: "class-bootstrap",
      protocolVersion: "0.1",
      requestId: "request-bootstrap-1",
    });
    const parsed = ClassBootstrapResponseSchema.parse(response);

    expect(parsed.requestId).toBe(request.requestId);
    expect(parsed.activeRun).toEqual(response.activeRun);
    expect(parsed.modelAlias).toBe("marea");
  });

  it("supports a student without an active run", () => {
    expect(
      ClassBootstrapResponseSchema.parse({ ...response, activeRun: null }).activeRun,
    ).toBeNull();
  });

  it.each(["studentId", "classId", "provider", "upstreamModel"])(
    "rejects private bootstrap field %s",
    (field) => {
      expect(() =>
        ClassBootstrapResponseSchema.parse({ ...response, [field]: "private" }),
      ).toThrow();
    },
  );

  it("rejects private nested fields and non-student principals", () => {
    expect(() =>
      ClassBootstrapResponseSchema.parse({
        ...response,
        classroom: { ...response.classroom, classId: "private" },
      }),
    ).toThrow();
    expect(() =>
      ClassBootstrapResponseSchema.parse({
        ...response,
        principal: { role: "teacher", displayName: "Ana" },
      }),
    ).toThrow();
  });
});
