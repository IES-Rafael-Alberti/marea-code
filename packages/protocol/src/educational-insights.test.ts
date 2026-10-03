import { expect, it, vi } from "vitest";
import type * as z from "zod";
// The schemas are built when the module loads, so each test imports it itself: mutation
// testing then attributes those module-level definitions to the tests that check them.
const load = () => {
  vi.resetModules();
  return import("./educational-insights.js");
};
const text = (length: number) => "a".repeat(length);
const list = (length: number) => Array.from({ length }, (_, index) => `item-${String(index)}`);
const accepts = (schema: z.ZodType, value: object) => schema.safeParse(value).success;
const target = {
  key: "criterion",
  skillId: "marea/testing",
  code: "C1",
  statement: "Test boundaries",
  levels: ["one", "two", "three", "four"],
  achieved: 0,
  target: 1,
  epoch: 0,
};
const scope = { protocolVersion: "0.1", requestId: "request:insight", classId: "class:one" };
const finding = {
  title: "Loops",
  mode: "tutoring",
  skillIds: [],
  evaluable: [],
  affected: [],
  evidence: [],
  explanation: "",
  recommendation: "",
};

it("publishes the endpoint and bounds learning targets and settings", async () => {
  const insights = await load();
  expect(insights.EDUCATIONAL_INSIGHTS_PATH).toBe("/api/v1/dashboard/educational-insights");
  expect(insights.MAX_INSIGHTS_BYTES).toBe(4194304);
  const { LearningTargetSchema: schema } = insights;
  expect(schema.parse(target)).toEqual(target);
  for (const [field, valid, invalid] of [
    ["key", [text(1), text(256)], ["", text(257)]],
    ["code", [text(1), text(64)], ["", text(65)]],
    ["statement", ["", text(1024)], [text(1025)]],
    ["achieved", [0, 4], [-1, 5, 1.5]],
    ["target", [1, 4], [0, 5]],
    ["epoch", [0, 9], [-1]],
    [
      "levels",
      [["", "", "", text(1024)]],
      [
        ["", "", ""],
        ["", "", "", text(1025)],
      ],
    ],
  ] as const) {
    for (const value of valid) expect(accepts(schema, { ...target, [field]: value })).toBe(true);
    for (const value of invalid) expect(accepts(schema, { ...target, [field]: value })).toBe(false);
  }
  expect(insights.AdaptiveContextSchema.parse({ targets: [target] })).toEqual({
    targets: [target],
  });
  expect(insights.InsightsSettingsSchema.parse({ map: true, adaptive: false })).toEqual({
    map: true,
    adaptive: false,
  });
});

it("accepts every request kind with its defaults", async () => {
  const { InsightsRequestSchema: schema } = await load();
  const report = { reportId: "report" };
  for (const [request, defaults] of [
    [{ kind: "settings" }, {}],
    [{ kind: "configure", settings: { map: true, adaptive: true }, expectedRevision: "r" }, {}],
    [{ kind: "map", viewerId: "viewer", visible: true }, {}],
    [{ kind: "progress", studentId: "student" }, {}],
    [{ kind: "overview" }, { after: null }],
    [
      {
        kind: "adjust",
        studentId: "student",
        keys: ["key"],
        level: 4,
        reason: "Reviewed",
        expectedRevision: "r",
      },
      {},
    ],
    [{ kind: "history", studentId: "student", key: "key" }, { after: 0 }],
    [{ kind: "reports" }, { after: null }],
    ...["es", "en", "eu"].map((locale) => [
      { kind: "generate", from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00Z", locale },
      {},
    ]),
    ...["report", "cancel", "retry", "download"].map((kind) => [{ kind, ...report }, {}]),
  ] as const)
    expect(schema.parse({ ...scope, ...request })).toEqual({ ...scope, ...request, ...defaults });
  expect(accepts(schema, { ...scope, kind: "unknown" })).toBe(false);
});

it("bounds request scope, adjustments and report generation", async () => {
  const { InsightsRequestSchema: schema } = await load();
  for (const classId of ["", text(257)])
    expect(accepts(schema, { ...scope, classId, kind: "settings" })).toBe(false);
  expect(accepts(schema, { ...scope, classId: text(256), kind: "settings" })).toBe(true);
  const adjust = {
    ...scope,
    kind: "adjust",
    studentId: "student",
    keys: ["key"],
    level: 0,
    reason: "Reviewed",
    expectedRevision: "r",
  };
  for (const [field, valid, invalid] of [
    ["keys", [list(1), list(64)], [[], list(65)]],
    ["level", [0, 4], [-1, 5, 0.5]],
    ["reason", [text(1), text(1000)], ["", "   ", text(1001)]],
  ] as const) {
    for (const value of valid) expect(accepts(schema, { ...adjust, [field]: value })).toBe(true);
    for (const value of invalid) expect(accepts(schema, { ...adjust, [field]: value })).toBe(false);
  }
  expect(schema.parse({ ...adjust, reason: "  Reviewed  " })).toMatchObject({ reason: "Reviewed" });
  const generate = {
    ...scope,
    kind: "generate",
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-02T00:00:00Z",
  };
  expect(accepts(schema, { ...generate, locale: "fr" })).toBe(false);
});

it("bounds attention and report findings and synthesis", async () => {
  const insights = await load();
  const attention = { state: "green", reason: "Progressing", confidence: "low" };
  for (const state of ["green", "yellow", "red"])
    expect(insights.AttentionSchema.parse({ ...attention, state })).toEqual({
      ...attention,
      state,
    });
  for (const confidence of ["low", "medium", "high"])
    expect(accepts(insights.AttentionSchema, { ...attention, confidence })).toBe(true);
  for (const reason of ["", text(321)])
    expect(accepts(insights.AttentionSchema, { ...attention, reason })).toBe(false);
  expect(accepts(insights.AttentionSchema, { ...attention, reason: text(320) })).toBe(true);
  const { ReportFindingSchema: schema } = insights;
  expect(schema.parse(finding)).toEqual(finding);
  for (const [field, valid, invalid] of [
    ["title", [text(1), text(200)], ["", text(201)]],
    ["mode", ["tutoring", "free"], ["other"]],
    ["skillIds", [list(64)], [list(65)]],
    ["evaluable", [list(1000)], [list(1001)]],
    ["affected", [list(1000)], [list(1001)]],
    ["evidence", [list(1000)], [list(1001)]],
    ["explanation", [text(4000)], [text(4001)]],
    ["recommendation", [text(2000)], [text(2001)]],
  ] as const) {
    for (const value of valid) expect(accepts(schema, { ...finding, [field]: value })).toBe(true);
    for (const value of invalid)
      expect(accepts(schema, { ...finding, [field]: value })).toBe(false);
  }
  const synthesis = { summary: "", findings: [finding], recommendation: "" };
  expect(insights.ReportSynthesisSchema.parse(synthesis)).toEqual(synthesis);
  for (const [field, value] of [
    ["summary", text(4001)],
    ["findings", Array.from({ length: 101 }, () => finding)],
    ["recommendation", text(3001)],
  ] as const)
    expect(accepts(insights.ReportSynthesisSchema, { ...synthesis, [field]: value })).toBe(false);
  for (const [field, value] of [
    ["summary", text(4000)],
    ["findings", Array.from({ length: 100 }, () => finding)],
    ["recommendation", text(3000)],
  ] as const)
    expect(accepts(insights.ReportSynthesisSchema, { ...synthesis, [field]: value })).toBe(true);
});
