import { expect, it } from "vitest";
import { fixture } from "./insights.fixture.js";
import { teacher } from "../../test-support/evaluation-fixture.js";

const definition = (key: string, code: string) =>
  JSON.stringify({
    key,
    skillId: "center/center:one/testing",
    code,
    statement: `Statement ${code}`,
    levels: ["one", "two", "three", "four"],
  });
function progress(f: ReturnType<typeof fixture>, student: string, key: string, level: number) {
  f.database.execute(
    "INSERT INTO marea_learning_progress (class_id,student_id,criterion_key,definition_json,level,epoch,revision) VALUES ('class:one', ?1, ?2, ?3, ?4, 0, ?5)",
    [student, key, definition(key, key.toUpperCase()), level, `revision:${student}:${key}`],
  );
}
function students(f: ReturnType<typeof fixture>, count: number) {
  for (let index = 0; index < count; index++) {
    const id = `student:${String(index).padStart(2, "0")}`;
    f.database.execute(
      "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?1, 'synthetic-hash', 'student', ?2, 'class:one')",
      [id, `Student ${String(index)}`],
    );
  }
}
const overview = (f: ReturnType<typeof fixture>, after: string | null = null) =>
  f.service.read(teacher, f.query({ kind: "overview", after })).data as {
    students: {
      id: string;
      displayName: string;
      revision: string;
      entries: { key: string; level: number }[];
    }[];
    next: string | null;
  };

it("lists every student with their own criteria and revision in one page", () => {
  const f = fixture();
  students(f, 2);
  progress(f, "student:00", "c1", 2);
  progress(f, "student:00", "c2", 4);
  progress(f, "student:01", "c1", 1);
  const page = overview(f);
  const first = page.students.find((student) => student.id === "student:00");
  const second = page.students.find((student) => student.id === "student:01");
  expect(first?.entries.map((entry) => [entry.key, entry.level])).toEqual([
    ["c1", 2],
    ["c2", 4],
  ]);
  expect(second?.entries.map((entry) => entry.key)).toEqual(["c1"]);
  // Each student's revision matches the one their own adjustments must present.
  expect(first?.revision).toBe(f.progress.read("class:one", "student:00").revision);
  expect(page.students.filter((student) => student.entries.length === 0).length).toBe(
    page.students.length - 2,
  );
  expect(page.next).toBeNull();
});

it("pages students by identifier and stops at the last page", () => {
  const f = fixture();
  students(f, 30);
  const all = f.database.readAll(
    "SELECT id FROM marea_users WHERE class_id = 'class:one' AND role = 'student' ORDER BY id",
  );
  const first = overview(f);
  expect(first.students).toHaveLength(25);
  expect(first.next).toBe(String(all[24]?.id));
  const second = overview(f, first.next);
  expect(second.students.map((student) => student.id)).toEqual(
    all.slice(25).map((row) => String(row.id)),
  );
  expect(second.next).toBeNull();
  // A page that ends exactly at the last student has nothing after it.
  expect(overview(f, String(all.at(-26)?.id)).next).toBeNull();
  expect(f.progress.overview("class:without-students", null)).toEqual({ students: [], next: null });
});
