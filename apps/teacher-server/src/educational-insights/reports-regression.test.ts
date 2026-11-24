import { expect, it, vi } from "vitest";
import * as z from "zod";
import type { InferenceProviderRequest } from "@marea/plugin-api";
import { fixture } from "./insights.fixture.js";
import { query, reportsWith, textProvider } from "./reports.fixture.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";

/**
 * A realistic lesson: thirty students, a model that wraps JSON in code fences, one answer that
 * needs a repair, one oversized answer with unknown keys, one very long session and a synthesis
 * that cites a run that does not exist.
 */
const SKILL = "teacher/t1/testing";
const STUDENTS = 30;
const alias = (n: number) => `A${String(n).padStart(3, "0")}`;
const two = (n: number) => String(n).padStart(2, "0");
const LONG = 4;

function lesson() {
  const f = fixture();
  f.database.execute("DELETE FROM marea_runs");
  const row = f.database.readOne(
    "SELECT teaching_json FROM marea_run_teaching_snapshots WHERE snapshot_id = 'snapshot:history'",
  );
  const teaching = z
    .object({ didacticSkills: z.array(z.object({ criteria: z.array(z.unknown()) }).loose()) })
    .loose()
    .parse(JSON.parse(String(row?.teaching_json)));
  teaching.didacticSkills[0]?.criteria.push({
    code: "C1",
    statement: "Explains how a loop terminates",
    levels: null,
  });
  f.database.execute(
    "UPDATE marea_run_teaching_snapshots SET teaching_json = ?1 WHERE snapshot_id = 'snapshot:history'",
    [JSON.stringify(teaching)],
  );
  for (let n = 1; n <= STUDENTS; n++) {
    const id = `st${two(n)}`;
    f.database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?2, 'hash', 'student', ?3, 'class:one')",
      [id, `student.${two(n)}@school.test`, `Student ${two(n)}`],
    );
    f.database.execute(
      "INSERT INTO marea_runs (id,student_id,class_id,snapshot_id,client_session_id,project_display_name,state,opened_at,closed_at) VALUES (?1,?2,'class:one','snapshot:history','client','Project','closed',?3,?3)",
      [`run:${id}`, id, NOW],
    );
    const messages =
      n === LONG
        ? [
            ...Array.from(
              { length: 2599 },
              (_v, i) => `Student 04 step ${String(i)} ${"y".repeat(100)}`,
            ),
            "Student 04 final: a for loop over range ends",
          ]
        : [
            `Student ${two(n)} asks how a for loop works`,
            "A loop repeats until its condition fails.",
            `student.${two(n)}@school.test tries a while loop`,
            "Check the loop bound.",
          ];
    for (const [index, content] of messages.entries())
      f.database.execute("INSERT INTO marea_run_events VALUES (?1,?2,?3,?4,?5,?6)", [
        `event:${id}:${String(index)}`,
        `run:${id}`,
        index + 1,
        NOW,
        index % 2 === 0 ? "student-message" : "assistant-message",
        JSON.stringify({ content }),
      ]);
  }
  return f;
}

const fence = (value: object) =>
  `Here is the JSON:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nDone.`;
function evaluation(n: number, extra: object = {}) {
  const failing = n % 5 === 0;
  return {
    studentFeedback: "Keep going",
    teacherNote: `${alias(n)} practised loops\nSecond line is dropped`,
    difficulties: failing ? ["Loop bounds"] : [],
    criteria: [
      {
        skillId: SKILL,
        code: "C1",
        result: failing ? "not-passed" : "passed",
        confidence: "high",
        evidence: "Observed in the session",
      },
    ],
    ...extra,
  };
}
const aliasOf = (request: InferenceProviderRequest) => {
  const found = /"content":"(A\d{3})/u.exec(request.messages[1]?.content ?? "");
  return Number(found?.[1]?.slice(1));
};
const isRepair = (request: InferenceProviderRequest) =>
  (request.messages[0]?.content ?? "").includes("Your previous answer was rejected");
const isEvaluation = (request: InferenceProviderRequest) =>
  (request.messages[0]?.content ?? "").startsWith("Draft a provisional evaluation");

const ALL = Array.from({ length: STUDENTS }, (_v, i) => alias(i + 1));
const FAILING = ALL.filter((_a, i) => (i + 1) % 5 === 0);
const loopBounds = {
  title: "Loop bounds",
  mode: "tutoring",
  skillIds: [SKILL],
  evaluable: ALL,
  affected: FAILING,
  evidence: FAILING.map((a) => `run:st${two(Number(a.slice(1)))}`),
  explanation: "Off-by-one bounds.",
  recommendation: "Trace a loop by hand.",
};
const invented = {
  title: "Invented evidence",
  mode: "tutoring",
  skillIds: [],
  evaluable: ["A001"],
  affected: ["A001"],
  evidence: ["run:ghost"],
  explanation: "Cites a run that does not exist.",
  recommendation: "None.",
};
const syntax = {
  title: "Loop syntax",
  mode: "tutoring",
  skillIds: [SKILL],
  evaluable: ["A001"],
  affected: ["A001", "A999"],
  evidence: ["run:st01"],
  explanation: "Syntax slips.",
  recommendation: "Pair practice.",
};
const synthesisAnswer = {
  summary: "Most students grasp loops; bounds remain difficult.",
  recommendation: "Revisit loop bounds.",
  unexpected: true,
  findings: [loopBounds, invented, { ...syntax, confidence: "high" }],
};

it("completes the class report of a thirty student lesson despite imperfect model output", async () => {
  const f = lesson();
  const requests: InferenceProviderRequest[] = [];
  const provider = textProvider((request) => {
    requests.push(request);
    if (!isEvaluation(request)) return fence(synthesisAnswer);
    const n = aliasOf(request);
    if (n === 8 && !isRepair(request)) return fence({ studentFeedback: "No criteria given" });
    if (n === 12)
      return fence(
        evaluation(n, { confidence: 0.8, teacherNote: `${alias(n)} ${"long ".repeat(5000)}` }),
      );
    return fence(evaluation(n));
  });
  const { reports } = reportsWith(f, provider);
  const queued = f.service.reports.generate(teacher, query(f));
  expect(queued.total).toBe(STUDENTS);
  await reports.tick();

  const report = reports.read(queued.id, "class:one");
  expect(report).toMatchObject({ state: "complete", error: null, completed: STUDENTS });
  expect(report.result?.partial).toBe(true);
  expect(report.result?.evidence).toHaveLength(STUDENTS);
  expect(report.result?.evidence.every((e) => e.status === "provisional")).toBe(true);
  expect(report.result?.evidence.map((e) => e.alias)).toEqual(ALL);

  // One repair for the incomplete answer, one synthesis: nothing else was retried.
  expect(requests).toHaveLength(STUDENTS + 2);
  expect(requests.filter(isRepair).map(aliasOf)).toEqual([8]);
  expect(requests.filter((r) => !isEvaluation(r))).toHaveLength(1);
  const repaired = report.result?.evidence[7]?.evaluation;
  expect(repaired?.criteria).toEqual([
    {
      skillId: SKILL,
      code: "C1",
      result: "passed",
      confidence: "high",
      evidence: "Observed in the session",
    },
  ]);

  // Oversized notes are clamped and unknown keys never reach the stored evaluation.
  const clamped = report.result?.evidence[11]?.evaluation;
  expect(clamped?.teacherNote).toHaveLength(16384);
  expect(clamped).not.toHaveProperty("confidence");

  // Valid findings survive with server computed denominators; invalid ones are dropped or repaired.
  expect(report.result?.synthesis).toEqual({
    summary: synthesisAnswer.summary,
    recommendation: synthesisAnswer.recommendation,
    findings: [
      { ...loopBounds, evaluable: ALL },
      { ...syntax, evaluable: ALL, affected: ["A001"] },
    ],
  });
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-findings-adjusted",
    reportId: queued.id,
    adjusted: 2,
  });
});

it("sends the model compact dossiers and the most recent part of a very long session", async () => {
  const f = lesson();
  const requests: InferenceProviderRequest[] = [];
  const { reports } = reportsWith(
    f,
    textProvider((request) => {
      requests.push(request);
      return isEvaluation(request)
        ? fence(evaluation(aliasOf(request)))
        : fence({ summary: "S", findings: [], recommendation: "R" });
    }),
  );
  const queued = f.service.reports.generate(teacher, query(f));
  await reports.tick();
  expect(reports.read(queued.id, "class:one")).toMatchObject({ state: "complete" });

  const long = requests.find((r) => isEvaluation(r) && aliasOf(r) === LONG);
  const sent = z
    .object({
      teaching: z.object({ didacticSkills: z.array(z.unknown()) }).loose(),
      session: z.object({
        events: z.array(z.object({ content: z.string() })),
        omittedEarlierEvents: z.number(),
      }),
    })
    .loose()
    .parse(JSON.parse(long?.messages[1]?.content ?? "null"));
  expect(Object.keys(sent.session).sort()).toEqual(["events", "omittedEarlierEvents"]);
  expect(sent.teaching.didacticSkills).toHaveLength(1);
  expect(sent.session.events.at(-1)?.content).toBe("A004 final: a for loop over range ends");
  expect(sent.session.omittedEarlierEvents + sent.session.events.length).toBe(2600);
  // The route ceiling, not the generic cap, bounds what a long session may send.
  const request = long?.messages.map((m) => Buffer.byteLength(m.content)) ?? [];
  expect(request.reduce((total, part) => total + part, 0)).toBeLessThanOrEqual(65536);
  expect(Buffer.byteLength(JSON.stringify(sent.session))).toBeLessThan(65536);
  expect(sent.session.events.length).toBeGreaterThan(300);
  expect(sent.session.omittedEarlierEvents).toBeGreaterThan(600);

  const synthesis = requests.find((r) => !isEvaluation(r));
  const user = synthesis?.messages[1]?.content ?? "";
  const dossiers = z
    .object({ evidence: z.array(z.object({ alias: z.string() }).loose()) })
    .parse(JSON.parse(user)).evidence;
  expect(dossiers).toHaveLength(STUDENTS);
  expect(dossiers[4]).toEqual({
    runId: "run:st05",
    alias: "A005",
    mode: "tutoring",
    skills: [SKILL],
    status: "provisional",
    results: { [SKILL]: "not-passed" },
    note: "A005 practised loops",
    difficulties: ["Loop bounds"],
  });
  expect(Buffer.byteLength(user)).toBeLessThan(20000);
  expect(user).not.toContain("Keep going");

  const everything = JSON.stringify([
    requests.map((r) => r.messages),
    vi.mocked(f.diagnostics).mock.calls,
  ]);
  for (const identity of ["Student 07", "student.07@school.test"])
    expect(everything).not.toContain(identity);
});
