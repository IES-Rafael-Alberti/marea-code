import { ClassBootstrapRequestSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { ClassBootstrapService } from "./class-bootstrap-service.js";

const REQUEST = ClassBootstrapRequestSchema.parse({
  kind: "class-bootstrap",
  protocolVersion: "0.1",
  requestId: "request:bootstrap",
});
const STUDENT: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};

describe("class bootstrap service", () => {
  it("derives a class and active run only from the authenticated student", () => {
    const service = new ClassBootstrapService({
      loadStudentBootstrap: () => ({
        activeRun: { projectDisplayName: "Wave lab", runId: "run:1" },
        classDisplayName: "Physics",
      }),
    });

    expect(service.load(STUDENT, REQUEST)).toMatchObject({
      activeRun: { projectDisplayName: "Wave lab", runId: "run:1", state: "active" },
      classroom: { displayName: "Physics" },
      modelAlias: "marea",
      principal: { displayName: "Student Alice", role: "student" },
    });
  });

  it("supports no active run and rejects unauthorized or missing class state", () => {
    const noRun = new ClassBootstrapService({
      loadStudentBootstrap: () => ({ activeRun: null, classDisplayName: "Physics" }),
    });
    expect(noRun.load(STUDENT, REQUEST).activeRun).toBeNull();

    for (const identity of [
      { ...STUDENT, role: "teacher" as const },
      { ...STUDENT, classId: null },
    ]) {
      expect(() => noRun.load(identity, REQUEST)).toThrow(
        expect.objectContaining({ code: "auth.invalid" }),
      );
    }
    const missing = new ClassBootstrapService({ loadStudentBootstrap: () => undefined });
    expect(() => missing.load(STUDENT, REQUEST)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
  });
});
