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
        students: [{ id: "s", displayName: "Ana", revision: "v", entries: [criterion] }],
        next: null,
      },
    ],
    [reportSchema, report],
    [reportsSchema, { configured: true, entries: [{ id: "r", state: "s", createdAt: "now" }] }],
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
