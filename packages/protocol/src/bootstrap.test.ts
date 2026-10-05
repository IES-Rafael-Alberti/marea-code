import { describe, expect, it } from "vitest";

import {
  ClassBootstrapOutcomeSchema,
  ClassBootstrapRequestSchema,
  ClassBootstrapResponseSchema,
  ClassSelectionRequiredResponseSchema,
  ClassSelectRequestSchema,
  MAX_SELECTABLE_CLASSES,
} from "./bootstrap.js";

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

describe("class selection protocol", () => {
  const selection = {
    kind: "class-selection-required",
    protocolVersion: "0.1",
    requestId: "request-bootstrap-2",
    principal: { role: "student", displayName: "Ana María" },
    classes: [
      { classId: "class-1", displayName: "Programming 1" },
      { classId: "class-2", displayName: "Databases" },
    ],
  } as const;

  it("lists distinct selectable classes for an unscoped student session", () => {
    expect(ClassSelectionRequiredResponseSchema.parse(selection).classes).toHaveLength(2);
    expect(
      ClassSelectionRequiredResponseSchema.parse({ ...selection, classes: [selection.classes[0]] })
        .classes,
    ).toHaveLength(1);
    expect(ClassBootstrapOutcomeSchema.parse(selection).kind).toBe("class-selection-required");
    expect(ClassBootstrapOutcomeSchema.parse(response).kind).toBe("class-bootstrapped");
    const many = Array.from({ length: MAX_SELECTABLE_CLASSES }, (_, index) => ({
      classId: `class-${String(index)}`,
      displayName: `Class ${String(index)}`,
    }));
    expect(
      ClassSelectionRequiredResponseSchema.parse({ ...selection, classes: many }).classes,
    ).toHaveLength(64);
  });

  it.each([
    ["no class", { classes: [] }],
    ["duplicate classes", { classes: [selection.classes[0], selection.classes[0]] }],
    [
      "too many classes",
      {
        classes: Array.from({ length: MAX_SELECTABLE_CLASSES + 1 }, (_, index) => ({
          classId: `class-${String(index)}`,
          displayName: "Class",
        })),
      },
    ],
    ["a teacher principal", { principal: { role: "teacher", displayName: "Teacher" } }],
    [
      "private fields",
      { classes: [{ ...selection.classes[0], centerId: "center" }, selection.classes[1]] },
    ],
    [
      "unsafe class ids",
      { classes: [{ ...selection.classes[0], classId: "-x" }, selection.classes[1]] },
    ],
  ])("rejects %s", (_, change) => {
    expect(() => ClassSelectionRequiredResponseSchema.parse({ ...selection, ...change })).toThrow();
  });

  it("explains duplicate selectable classes", () => {
    expect(
      ClassSelectionRequiredResponseSchema.safeParse({
        ...selection,
        classes: [selection.classes[0], selection.classes[0]],
      }).error?.issues[0]?.message,
    ).toBe("Selectable classes must be unique.");
  });

  it("selects one class by its opaque identifier only", () => {
    const request = {
      kind: "class-select",
      protocolVersion: "0.1",
      requestId: "request-select-1",
      classId: "class-2",
    } as const;
    expect(ClassSelectRequestSchema.parse(request)).toEqual(request);
    expect(() => ClassSelectRequestSchema.parse({ ...request, userId: "user-1" })).toThrow();
    expect(() => ClassSelectRequestSchema.parse({ ...request, classId: "" })).toThrow();
  });
});
