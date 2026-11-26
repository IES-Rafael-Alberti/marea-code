import { expect, it, vi } from "vitest";
// The schemas are built when the module loads, so the test imports it itself: mutation
// testing then attributes those module-level definitions to the test that checks them.
const load = () => {
  vi.resetModules();
  return import("./educational-insights.js");
};
const scope = { protocolVersion: "0.1", requestId: "request:insight", classId: "class:one" };
const text = (length: number) => "a".repeat(length);

it("bounds the dashboard-only learning notes requests", async () => {
  const insights = await load();
  const schema = insights.InsightsRequestSchema;
  expect(insights.MAX_LEARNING_NOTES_CHARACTERS).toBe(200_000);
  expect(insights.MAX_INSIGHTS_REQUEST_BYTES).toBe(2_097_152);
  for (const kind of ["notes", "propose-notes"]) {
    const request = { ...scope, kind, studentId: "s1", key: "criterion" };
    expect(schema.parse(request)).toEqual(request);
    expect(schema.safeParse({ ...request, key: "" }).success).toBe(false);
    expect(schema.safeParse({ ...request, studentId: text(257) }).success).toBe(false);
    expect(schema.safeParse({ ...request, notes: "" }).success).toBe(false);
  }
  const save = {
    ...scope,
    kind: "save-notes",
    studentId: "s1",
    key: "criterion",
    notes: "",
    expectedRevision: "sha256:x",
  };
  expect(schema.parse(save)).toEqual(save);
  expect(schema.parse({ ...save, notes: text(200_000) })).toMatchObject({ kind: "save-notes" });
  for (const invalid of [
    { notes: text(200_001) },
    { expectedRevision: "" },
    { key: text(257) },
    { extra: true },
  ])
    expect(schema.safeParse({ ...save, ...invalid }).success).toBe(false);
  expect(schema.safeParse({ ...save, notes: undefined }).success).toBe(false);
});
