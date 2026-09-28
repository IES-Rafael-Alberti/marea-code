import { afterEach, expect, it, vi } from "vitest";
import { evidenceFixture, evidenceQuery, NOW, teacher } from "./evidence.fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { storedEvaluationInput } from "../platform/persistence/sqlite-evaluation-record.js";
import { evaluationDigest } from "../evaluation/evaluation-input.js";
import { digestSkillFiles } from "../teaching/skills/skill-digest.js";
import { ZodError } from "zod";

let f: ReturnType<typeof evidenceFixture>;
function duplicate(id: string, runId: string, generation = 1) {
  f.database.execute(
    `INSERT INTO marea_evaluations
    SELECT ?1, ?2, ?3, action_owner, ?1, request_fingerprint, input_json, input_digest,
      state, created_at, updated_at, worker_token, draft_json, failure_code, notice_id, approved_at, review_owner, ?1, review_fingerprint
    FROM marea_evaluations WHERE id = 'evaluation:1'`,
    [id, runId, generation],
  );
}
afterEach(() => {
  f.database.close();
  vi.restoreAllMocks();
});
it("projects only approved criteria, frozen statements and reviewed evidence without private fields", () => {
  f = evidenceFixture();
  expect(f.service.read(teacher, evidenceQuery()).entries).toEqual([]);
  f.approve();
  expect(f.service.read(teacher, evidenceQuery())).toMatchObject({
    kind: "students",
    entries: [{ studentId: "s1" }],
    next: null,
  });
  const criteria = f.service.read(
    teacher,
    evidenceQuery({ kind: "criteria", studentId: "s1", limit: 1 }),
  );
  expect(criteria).toMatchObject({
    kind: "criteria",
    entries: [{ ...f.criterion, statement: "Frozen boundary" }],
    next: f.criterion,
  });
  expect(
    f.service.read(
      teacher,
      evidenceQuery({ kind: "criteria", studentId: "s1", after: criteria.next }),
    ),
  ).toMatchObject({ entries: [{ code: "failure", statement: "Frozen failure" }], next: null });
  const history = f.service.read(
    teacher,
    evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion }),
  );
  expect(history).toMatchObject({
    kind: "history",
    entries: [
      {
        ...f.draft.criteria[0],
        evaluationId: "evaluation:1",
        runId: "run:b",
        generation: 1,
        approvedAt: NOW,
        hasLaterApproval: false,
      },
    ],
    next: null,
  });
  expect(JSON.stringify(history)).not.toMatch(
    /teacherNote|studentFeedback|difficulties|Private|providerRoute|input_json/,
  );
  expect(
    f.service.read(
      teacher,
      evidenceQuery({ kind: "history", studentId: "s2", criterion: f.criterion }),
    ).entries,
  ).toEqual([]);
});
it("keeps all approvals, orders by date and ID and scopes every cursor to its student and class", () => {
  f = evidenceFixture();
  f.approve();
  f.database.execute(`INSERT INTO marea_evaluations
    SELECT 'evaluation:2', run_id, 2, action_owner, 'generate:2', request_fingerprint, input_json, input_digest,
      state, created_at, updated_at, worker_token, draft_json, failure_code, notice_id, approved_at, review_owner, 'review:2', review_fingerprint
    FROM marea_evaluations WHERE id = 'evaluation:1'`);
  const first = f.service.read(
    teacher,
    evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion, limit: 1 }),
  );
  expect(first).toMatchObject({
    entries: [{ evaluationId: "evaluation:2", hasLaterApproval: false }],
    next: { evaluationId: "evaluation:2", approvedAt: NOW },
  });
  expect(
    f.service.read(
      teacher,
      evidenceQuery({
        kind: "history",
        studentId: "s1",
        criterion: f.criterion,
        after: first.next,
      }),
    ),
  ).toMatchObject({
    entries: [{ evaluationId: "evaluation:1", hasLaterApproval: true }],
    next: null,
  });
  expect(
    f.service.read(
      teacher,
      evidenceQuery({
        kind: "history",
        studentId: "s2",
        criterion: f.criterion,
        after: first.next,
      }),
    ).entries,
  ).toEqual([]);
  expect(
    f.service.read(
      teacher,
      evidenceQuery({ kind: "criteria", studentId: "s2", after: f.criterion }),
    ).entries,
  ).toEqual([]);
  expect(() => f.service.read(teacher, evidenceQuery({ classId: "class:two" }))).toThrow();
  f.database.execute(
    "UPDATE marea_evaluations SET approved_at = '2026-09-06T12:00:00.000Z' WHERE id = 'evaluation:2'",
  );
  expect(
    f.service.read(
      teacher,
      evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion, limit: 1 }),
    ),
  ).toMatchObject({ entries: [{ evaluationId: "evaluation:1" }] });
});
it("requires current teacher authority in the same transaction, and does not infer authority from roles or supplied IDs", () => {
  f = evidenceFixture();
  f.approve();
  expect(() => f.service.read(student, evidenceQuery())).toThrow();
  expect(() => f.service.read({ ...teacher, role: "student" }, evidenceQuery())).toThrow(
    expect.objectContaining({ code: "dashboard.forbidden" }),
  );
  expect(() => f.service.read({ ...teacher, userId: "t2" }, evidenceQuery())).toThrow();
  const transaction = vi.spyOn(f.repository, "transaction");
  f.service.read(teacher, evidenceQuery());
  expect(transaction).toHaveBeenCalledOnce();
  f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  expect(() => f.service.read(teacher, evidenceQuery())).toThrow();
});

it("ends exactly full pages and selects the requested assessment rather than the first one", () => {
  f = evidenceFixture();
  f.approve();
  expect(
    f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1", limit: 2 })).next,
  ).toBeNull();
  expect(
    f.service.read(
      teacher,
      evidenceQuery({
        kind: "history",
        studentId: "s1",
        criterion: { ...f.criterion, code: "failure" },
        limit: 1,
      }),
    ),
  ).toMatchObject({ entries: [{ code: "failure", evidence: "Reviewed failure" }], next: null });
  f.database.execute("UPDATE marea_evaluations SET draft_json = ?1", [
    JSON.stringify({
      ...f.draft,
      criteria: [
        { ...f.draft.criteria[0], skillId: "marea/other", evidence: "WRONG SKILL" },
        ...f.draft.criteria,
      ],
    }),
  ]);
  expect(
    f.service.read(
      teacher,
      evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion }),
    ),
  ).toMatchObject({ entries: [{ skillId: f.criterion.skillId, evidence: "Reviewed boundary" }] });
});

it.each(["missing-content", "missing-skill", "wrong-id", "wrong-digest"])(
  "uses only the exact frozen skill and digest (%s)",
  (mode) => {
    f = evidenceFixture();
    f.approve();
    const row = f.database.readOne("SELECT * FROM marea_evaluations");
    if (row === undefined) throw new Error("missing fixture");
    const input = storedEvaluationInput(row),
      content = input.content;
    if (content === null) throw new Error("missing capture");
    const source = content.teaching.didacticSkills[0];
    if (source === undefined) throw new Error("missing skill");
    const files = [{ path: "SKILL.md", content: "changed", sizeBytes: 7 }];
    const wrong = {
      ...source,
      ...(mode === "wrong-id"
        ? { id: "teacher/t1/other", name: "other" }
        : { files, digest: digestSkillFiles(files) }),
      criteria: source.criteria.map((criterion) => ({ ...criterion, statement: "WRONG VERSION" })),
    };
    const changed = JSON.stringify({
      ...input,
      content:
        mode === "missing-content"
          ? null
          : {
              ...content,
              teaching: {
                ...content.teaching,
                didacticSkills: mode === "missing-skill" ? [] : [wrong, source],
              },
            },
    });
    f.database.execute("UPDATE marea_evaluations SET input_json = ?1, input_digest = ?2", [
      changed,
      evaluationDigest(changed),
    ]);
    const read = () =>
      f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1" }));
    if (mode.startsWith("missing"))
      expect(read).toThrow(expect.objectContaining({ code: "request.conflict" }));
    else
      expect(read()).toMatchObject({
        entries: [{ statement: "Frozen boundary" }, { statement: "Frozen failure" }],
      });
  },
);

it("validates the complete approved record before exposing its criterion statement", () => {
  f = evidenceFixture();
  f.approve();
  const read = f.database.readOne.bind(f.database);
  vi.spyOn(f.database, "readOne").mockImplementation((sql, parameters) => {
    const row = read(sql, parameters);
    return row !== undefined && sql.startsWith("SELECT e.*") ? { ...row, draft_json: "{}" } : row;
  });
  expect(() =>
    f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1" })),
  ).toThrow(ZodError);
});
it("rejects damaged captured bytes instead of returning unverifiable evidence", () => {
  f = evidenceFixture();
  f.approve();
  f.database.execute("UPDATE marea_evaluations SET input_digest = 'sha256:bad'");
  for (const kind of ["criteria", "history"])
    expect(() =>
      f.service.read(
        teacher,
        evidenceQuery({
          kind,
          studentId: "s1",
          ...(kind === "history" ? { criterion: f.criterion } : {}),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
});
it("rejects a missing historical criterion and does not substitute installed skill text", () => {
  f = evidenceFixture();
  f.approve();
  const row = f.database.readOne("SELECT * FROM marea_evaluations");
  if (row === undefined) throw new Error("missing fixture");
  const input = storedEvaluationInput(row);
  if (input.content === null) throw new Error("missing capture");
  const text = JSON.stringify({
    ...input,
    content: {
      ...input.content,
      teaching: {
        ...input.content.teaching,
        didacticSkills: input.content.teaching.didacticSkills.map((skill) => ({
          ...skill,
          criteria: [],
        })),
      },
    },
  });
  f.database.execute("UPDATE marea_evaluations SET input_json = ?1, input_digest = ?2", [
    text,
    evaluationDigest(text),
  ]);
  expect(() =>
    f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1" })),
  ).toThrow(expect.objectContaining({ code: "request.conflict" }));
});

it("paginates homonymous identities independently and removes evidence with its source run", () => {
  f = evidenceFixture();
  f.approve();
  f.database.execute(
    "UPDATE marea_runs SET student_id = 's2', state = 'closed' WHERE id = 'run:a'",
  );
  f.database.execute("UPDATE marea_users SET display_name = 'Same name' WHERE id IN ('s1','s2')");
  duplicate("evaluation:other", "run:a");
  const first = f.service.read(teacher, evidenceQuery({ limit: 1 }));
  expect(first).toMatchObject({
    entries: [{ studentId: "s1", displayName: "Same name" }],
    next: "s1",
  });
  expect(f.service.read(teacher, evidenceQuery({ after: first.next, limit: 1 }))).toMatchObject({
    entries: [{ studentId: "s2", displayName: "Same name" }],
    next: null,
  });
  f.database.execute("DELETE FROM marea_runs WHERE id = 'run:a'");
  expect(f.service.read(teacher, evidenceQuery({ after: "s1" })).entries).toEqual([]);
});

it("separates changed frozen versions and preserves no-evidence instead of fabricating failure", () => {
  f = evidenceFixture();
  f.approve();
  duplicate("evaluation:version", "run:older");
  const row = f.database.readOne("SELECT * FROM marea_evaluations WHERE id = 'evaluation:version'");
  if (row === undefined) throw new Error("missing fixture");
  const input = storedEvaluationInput(row);
  if (input.content === null) throw new Error("missing capture");
  const files = [{ path: "SKILL.md", content: "version two", sizeBytes: 11 }];
  const digest = digestSkillFiles(files);
  const changed = JSON.stringify({
    ...input,
    didacticSkills: input.didacticSkills.map((skill) => ({ ...skill, digest })),
    content: {
      ...input.content,
      teaching: {
        ...input.content.teaching,
        didacticSkills: input.content.teaching.didacticSkills.map((skill) => ({
          ...skill,
          files,
          digest,
          criteria: skill.criteria.map((criterion) => ({
            ...criterion,
            statement: "Changed statement",
          })),
        })),
      },
    },
  });
  f.database.execute(
    "UPDATE marea_evaluations SET input_json = ?1, input_digest = ?2, draft_json = ?3 WHERE id = 'evaluation:version'",
    [
      changed,
      evaluationDigest(changed),
      JSON.stringify({
        ...f.draft,
        criteria: f.draft.criteria.map((criterion) => ({
          ...criterion,
          result: "no-evidence",
          evidence: "",
          confidence: "low",
        })),
      }),
    ],
  );
  expect(
    f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1" })).entries,
  ).toHaveLength(4);
  const old = f.service.read(
    teacher,
    evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion }),
  );
  expect(old.entries).toHaveLength(1);
  const current = f.service.read(
    teacher,
    evidenceQuery({ kind: "history", studentId: "s1", criterion: { ...f.criterion, digest } }),
  );
  expect(current).toMatchObject({
    entries: [
      {
        evaluationId: "evaluation:version",
        result: "no-evidence",
        confidence: "low",
        evidence: "",
      },
    ],
  });
});

it("rejects records disappearing from a criteria projection instead of supplying defaults", () => {
  f = evidenceFixture();
  f.approve();
  const read = f.database.readOne.bind(f.database);
  vi.spyOn(f.database, "readOne").mockImplementation((sql, parameters) =>
    sql.startsWith("SELECT e.*") ? undefined : read(sql, parameters),
  );
  expect(() =>
    f.service.read(teacher, evidenceQuery({ kind: "criteria", studentId: "s1" })),
  ).toThrow(expect.objectContaining({ code: "request.conflict" }));
});

it.each(["state", "criteria"])(
  "validates unexpected %s in the storage adapter before publishing a history page",
  (field) => {
    f = evidenceFixture();
    f.approve();
    const read = f.database.readAll.bind(f.database);
    vi.spyOn(f.database, "readAll").mockImplementation((sql, parameters) => {
      const rows = read(sql, parameters);
      if (!sql.includes("SELECT e.*, EXISTS")) return rows;
      return rows.map((row) => ({
        ...row,
        ...(field === "state"
          ? { state: "draft" }
          : { draft_json: JSON.stringify({ ...f.draft, criteria: [] }) }),
      }));
    });
    expect(() =>
      f.service.read(
        teacher,
        evidenceQuery({ kind: "history", studentId: "s1", criterion: f.criterion }),
      ),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  },
);
