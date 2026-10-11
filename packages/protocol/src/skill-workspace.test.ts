import { expect, it } from "vitest";
import {
  SKILL_WORKSPACE_PATH,
  SkillWorkspaceRequestSchema,
  SkillWorkspaceResponseSchema,
} from "./skill-workspace.js";
const envelope = { protocolVersion: "0.1", requestId: "request:test", classId: "class:one" };
const digest = `sha256:${"a".repeat(64)}`;
const assignment = {
  ...envelope,
  kind: "assign",
  expectedClassVersion: "revision:one",
  students: [{ studentId: "student:one", expectedVersion: null }],
  selection: [{ id: "marea/testing", digest }],
};
it("distinguishes inherited and empty individual selections with bounded atomic target lists", () => {
  for (const selection of [null, [], assignment.selection])
    expect(SkillWorkspaceRequestSchema.parse({ ...assignment, selection })).toMatchObject({
      selection,
    });
  for (const patch of [
    { students: [] },
    { students: [...assignment.students, ...assignment.students] },
    {
      students: Array.from({ length: 101 }, (_, i) => ({
        studentId: `student:${String(i)}`,
        expectedVersion: null,
      })),
    },
    { selection: [...assignment.selection, ...assignment.selection] },
    {
      selection: Array.from({ length: 65 }, (_, i) => ({ id: `marea/skill-${String(i)}`, digest })),
    },
    { expectedClassVersion: null },
    { extra: true },
  ])
    expect(SkillWorkspaceRequestSchema.safeParse({ ...assignment, ...patch }).success).toBe(false);
  expect(
    SkillWorkspaceRequestSchema.safeParse({
      ...assignment,
      students: Array.from({ length: 100 }, (_, i) => ({
        studentId: `student:${String(i)}`,
        expectedVersion: "revision:one",
      })),
      selection: Array.from({ length: 64 }, (_, i) => ({ id: `marea/skill-${String(i)}`, digest })),
    }).success,
  ).toBe(true);
});
it("requires a reviewed usage revision before applying a library edit", () => {
  const request = {
    ...envelope,
    kind: "apply",
    skillId: "teacher/t1/testing",
    digest,
    expectedUsage: digest,
  };
  expect(SkillWorkspaceRequestSchema.parse(request)).toEqual(request);
  for (const value of [null, "wrong", undefined])
    expect(
      SkillWorkspaceRequestSchema.safeParse({ ...request, expectedUsage: value }).success,
    ).toBe(false);
});
it("bounds roster and library pages and does not leak private skill content into summaries", () => {
  const student = { studentId: "s1", displayName: "Ana", version: null, selection: null };
  const response = {
    ...envelope,
    kind: "students",
    students: Array.from({ length: 100 }, () => student),
    next: "s2",
  };
  expect(SkillWorkspaceResponseSchema.safeParse(response).success).toBe(true);
  expect(
    SkillWorkspaceResponseSchema.safeParse({
      ...response,
      students: [...response.students, student],
    }).success,
  ).toBe(false);
  const skill = {
    id: "marea/testing",
    name: "testing",
    title: "Testing",
    description: "Practice",
    kind: "didactic",
    source: "marea",
    digest,
    compatibility: null,
  };
  const library = { ...envelope, kind: "library", skills: [skill], next: null };
  expect(SkillWorkspaceResponseSchema.safeParse(library).success).toBe(true);
  expect(
    SkillWorkspaceResponseSchema.safeParse({ ...library, skills: [{ ...skill, files: [] }] })
      .success,
  ).toBe(false);
  expect(
    SkillWorkspaceResponseSchema.safeParse({ ...library, skills: [{ ...skill, title: "" }] })
      .success,
  ).toBe(false);
  expect(
    SkillWorkspaceResponseSchema.safeParse({
      ...library,
      skills: Array.from({ length: 101 }, () => skill),
    }).success,
  ).toBe(false);
});

it("accepts each correlated operation and exposes bounded, nonnegative usage summaries", () => {
  expect(SKILL_WORKSPACE_PATH).toBe("/api/v1/dashboard/skill-workspace");
  for (const input of [
    { kind: "library", after: null },
    { kind: "students", after: null },
    { kind: "usage", skillId: "marea/testing" },
  ]) {
    const request = { ...envelope, ...input };
    expect(SkillWorkspaceRequestSchema.parse(request)).toEqual(request);
  }
  for (const kind of ["assigned", "applied"]) {
    const response = { ...envelope, kind };
    expect(SkillWorkspaceResponseSchema.parse(response)).toEqual(response);
  }
  const use = { classId: "class:one", displayName: "Physics", classroom: true, students: 2 };
  const usage = { ...envelope, kind: "usage", version: digest, uses: [use] };
  expect(SkillWorkspaceResponseSchema.parse(usage)).toEqual(usage);
  for (const students of [-1, 0.5])
    expect(
      SkillWorkspaceResponseSchema.safeParse({ ...usage, uses: [{ ...use, students }] }).success,
    ).toBe(false);
});
