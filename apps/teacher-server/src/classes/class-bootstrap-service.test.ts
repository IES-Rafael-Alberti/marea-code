import { ClassBootstrapRequestSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { AuthenticatedIdentity, StudentClassChoice } from "../identity/contracts.js";
import type { ClassroomRepository, StudentClassBootstrap } from "./contracts.js";
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

function repository(
  bootstrap: StudentClassBootstrap | undefined,
  classes: readonly StudentClassChoice[] = [],
): ClassroomRepository & { readonly listed: string[] } {
  const listed: string[] = [];
  return {
    listed,
    loadStudentBootstrap: () => bootstrap,
    studentClasses: (userId) => {
      listed.push(userId);
      return classes;
    },
  };
}

describe("class bootstrap service", () => {
  it("derives a class and active run only from the authenticated student", () => {
    const service = new ClassBootstrapService(
      repository({
        activeRun: { projectDisplayName: "Wave lab", runId: "run:1" },
        classDisplayName: "Physics",
      }),
    );

    expect(service.load(STUDENT, REQUEST)).toMatchObject({
      activeRun: { projectDisplayName: "Wave lab", runId: "run:1", state: "active" },
      classroom: { displayName: "Physics" },
      kind: "class-bootstrapped",
      modelAlias: "marea",
      principal: { displayName: "Student Alice", role: "student" },
    });
  });

  it("supports no active run and rejects unauthorized or missing class state", () => {
    const noRun = new ClassBootstrapService(
      repository({ activeRun: null, classDisplayName: "Physics" }),
    );
    expect(noRun.load(STUDENT, REQUEST)).toMatchObject({ activeRun: null });

    for (const identity of [
      { ...STUDENT, role: "teacher" as const },
      { ...STUDENT, role: "teacher" as const, classId: null },
      { ...STUDENT, classId: null },
    ]) {
      expect(() => noRun.load(identity, REQUEST)).toThrow(
        expect.objectContaining({ code: "auth.invalid" }),
      );
    }
    const missing = new ClassBootstrapService(repository(undefined));
    expect(() => missing.load(STUDENT, REQUEST)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
  });

  it("asks an unscoped student to choose among the classes it may act for", () => {
    const classes = [
      { classId: "class:databases", displayName: "Databases" },
      { classId: "class:physics", displayName: "Physics" },
    ];
    const source = repository(undefined, classes);
    const service = new ClassBootstrapService(source);
    expect(service.load({ ...STUDENT, classId: null }, REQUEST)).toEqual({
      classes,
      kind: "class-selection-required",
      principal: { displayName: "Student Alice", role: "student" },
      protocolVersion: "0.1",
      requestId: "request:bootstrap",
    });
    expect(source.listed).toEqual(["user:alice"]);
    expect(() => service.load({ ...STUDENT, role: "teacher", classId: null }, REQUEST)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(source.listed).toEqual(["user:alice"]);
  });
});
