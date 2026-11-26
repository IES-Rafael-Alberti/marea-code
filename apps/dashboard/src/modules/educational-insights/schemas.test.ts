import { expect, it, vi } from "vitest";
// The schemas are built when the module loads, so each test imports it itself: mutation
// testing then attributes those module-level definitions to the tests that check them.
const load = () => {
  vi.resetModules();
  return import("./schemas.js");
};
const budget = {
  requests: 1,
  tokens: 2,
  costUnits: 3,
  maxRequests: 4,
  maxTokens: 5,
  maxCostUnits: 6,
  costUnit: "units",
};
const entry = {
  runId: "run",
  student: "Ana",
  project: "P",
  state: "green",
  reason: "",
  confidence: "low",
  analyzedAt: null,
};
const criterion = {
  key: "key",
  skillId: "skill",
  code: "C1",
  statement: "S",
  level: 1,
  levels: ["1", "2", "3", "4"],
  epoch: 0,
  notesLength: 0,
};
const evidence = {
  runId: "run",
  alias: "A",
  mode: "tutoring",
  status: "approved",
  evaluation: null,
};
const report = {
  budget,
  students: [{ alias: "A", displayName: "Ana" }],
  id: "report",
  state: "complete",
  from: "from",
  to: "to",
  completed: 1,
  total: 1,
  result: {
    partial: false,
    synthesis: { summary: "S", recommendation: "R", findings: [] },
    evidence: [evidence],
  },
};
const history = {
  id: 1,
  runId: null,
  previousLevel: 0,
  level: 1,
  reason: "R",
  actor: "teacher",
  createdAt: "now",
};

it("keeps every field of the dashboard's responses", async () => {
  const { budgetSchema, historySchema, mapSchema, overviewSchema, reportSchema, reportsSchema } =
    await load();
  const cases = [
    [budgetSchema, budget],
    [mapSchema, { budget, enabled: true, configured: true, entries: [entry] }],
    [
      overviewSchema,
      {
        students: [
          { id: "s", displayName: "Ana", revision: "v", entries: [criterion], notesNotice: null },
        ],
        next: null,
      },
    ],
    [reportSchema, report],
    [
      reportsSchema,
      {
        configured: true,
        entries: [
          { id: "r", state: "s", createdAt: "now", from: "a", to: "b", completed: 1, total: 2 },
        ],
      },
    ],
    [historySchema, { entries: [history] }],
  ] as const;
  for (const [schema, value] of cases) expect(schema.parse(value)).toStrictEqual(value);
});

it("accepts exactly the attention, confidence and evidence states the server sends", async () => {
  const { mapSchema, reportSchema } = await load();
  const states = ["green", "yellow", "red", "error", "disabled", "disconnected", "pending"];
  for (const state of states)
    expect(mapSchema.shape.entries.element.parse({ ...entry, state }).state).toBe(state);
  for (const confidence of ["low", "medium", "high"])
    expect(mapSchema.shape.entries.element.parse({ ...entry, confidence }).confidence).toBe(
      confidence,
    );
  const item = reportSchema.shape.result.unwrap().shape.evidence.element;
  for (const status of ["approved", "provisional", "unavailable"])
    expect(item.parse({ ...evidence, status }).status).toBe(status);
  expect(item.safeParse({ ...evidence, status: "" }).success).toBe(false);
  expect(reportSchema.parse({ ...report, students: undefined }).students).toEqual([]);
});

it("accepts a report with or without a failure code and an unavailable reason", async () => {
  const { reportSchema } = await load();
  expect(reportSchema.parse({ ...report, error: "budget" }).error).toBe("budget");
  expect(reportSchema.parse({ ...report, error: null }).error).toBeNull();
  expect(reportSchema.parse(report).error).toBeUndefined();
  const item = reportSchema.shape.result.unwrap().shape.evidence.element;
  expect(item.parse({ ...evidence, status: "unavailable", reason: "provider" }).reason).toBe(
    "provider",
  );
  expect(item.parse(evidence).reason).toBeUndefined();
  expect(item.safeParse({ ...evidence, reason: 1 }).success).toBe(false);
});

it("keeps the learning notes fields and the session notice", async () => {
  const { notesSchema, overviewSchema, proposalSchema, savedNotesSchema } = await load();
  const notes = { notes: "07/09/2026: N.", omitted: 0, revision: "sha256:a" };
  expect(notesSchema.parse(notes)).toStrictEqual(notes);
  expect(savedNotesSchema.parse({ ...notes, conflict: true })).toStrictEqual({
    ...notes,
    conflict: true,
  });
  expect(savedNotesSchema.safeParse(notes).success).toBe(false);
  for (const value of [
    { proposal: "S", failure: null },
    { proposal: null, failure: "budget" },
  ])
    expect(proposalSchema.parse(value)).toStrictEqual(value);
  expect(proposalSchema.safeParse({ proposal: null }).success).toBe(false);
  const student = (notesNotice: object | null) => ({
    students: [{ id: "s", displayName: "Ana", revision: "v", entries: [criterion], notesNotice }],
    next: null,
  });
  for (const shortened of ["summarized", "trimmed"]) {
    const value = student({ sessionDate: "07/09/2026", shortened });
    expect(overviewSchema.parse(value)).toStrictEqual(value);
  }
  expect(overviewSchema.safeParse(student({ sessionDate: "x", shortened: "" })).success).toBe(
    false,
  );
  expect(overviewSchema.safeParse(student({ shortened: "trimmed" })).success).toBe(false);
  const old = { ...student(null).students[0], entries: [{ ...criterion, notesLength: "1" }] };
  expect(overviewSchema.safeParse({ students: [old], next: null }).success).toBe(false);
});
