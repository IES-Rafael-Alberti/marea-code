import { expect, it, vi } from "vitest";
import * as z from "zod";
import { fixture } from "./insights.fixture.js";
import { input, query } from "./reports.fixture.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";

function sourceRuns(count: number) {
  const f = fixture();
  f.database.execute("DELETE FROM marea_runs");
  for (let index = 0; index < count; index++) {
    const id = `run:${String(index).padStart(3, "0")}`;
    f.database.execute(
      "INSERT INTO marea_runs (id,student_id,class_id,snapshot_id,client_session_id,project_display_name,state,opened_at,closed_at) VALUES (?1,'s1','class:one','snapshot:history','client','Project','closed',?2,?2)",
      [id, NOW],
    );
    f.database.execute("INSERT INTO marea_run_events VALUES (?1,?2,1,?3,'student-message',?4)", [
      `event:${id}`,
      id,
      NOW,
      JSON.stringify({ content: "" }),
    ]);
  }
  return f;
}

it("accepts exactly two hundred source runs", () => {
  const f = sourceRuns(200);
  const report = f.service.reports.generate(teacher, query(f));
  expect(report.total).toBe(200);
  expect(f.database.readAll("SELECT run_id FROM marea_class_report_sources")).toHaveLength(200);
});

it("retains exactly two thousand events rather than marking their source unavailable", () => {
  const f = sourceRuns(1);
  for (let index = 2; index <= 2000; index++)
    f.database.execute(
      "INSERT INTO marea_run_events VALUES (?1,'run:000',?2,?3,'student-message',?4)",
      [`event:${String(index)}`, index, NOW, JSON.stringify({ content: "evidence" })],
    );
  const report = f.service.reports.generate(teacher, query(f));
  const material = input(f, report.id).sources[0]?.material;
  expect(material).not.toBe("");
  expect(
    z.object({ events: z.array(z.json()) }).parse(JSON.parse(material ?? "null")).events,
  ).toHaveLength(2000);
});

it("accepts a source at its exact byte limit", () => {
  const f = sourceRuns(1);
  const report = f.service.reports.generate(teacher, query(f));
  const base = input(f, report.id).sources[0]?.material;
  if (base === undefined) throw new Error("material");
  f.service.reports.cancel(report.id, "class:one");
  f.database.execute("UPDATE marea_run_events SET payload_json = ?1", [
    JSON.stringify({ content: "x".repeat(262144 - Buffer.byteLength(base)) }),
  ]);
  const exact = f.service.reports.generate(teacher, query(f, { requestId: "exact-source" }));
  expect(Buffer.byteLength(input(f, exact.id).sources[0]?.material ?? "")).toBe(262144);
});

it("accepts exactly eight MiB of frozen report input", () => {
  const f = sourceRuns(32);
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  let remaining = 8 * 1048576 - Buffer.byteLength(JSON.stringify(frozen));
  for (const source of frozen.sources) {
    const padding = Math.min(remaining, 262144 - Buffer.byteLength(source.material));
    remaining -= padding;
    f.database.execute("UPDATE marea_run_events SET payload_json = ?2 WHERE run_id = ?1", [
      source.runId,
      JSON.stringify({ content: "x".repeat(padding) }),
    ]);
  }
  expect(remaining).toBe(0);
  f.service.reports.cancel(report.id, "class:one");
  const exact = f.service.reports.generate(teacher, query(f, { requestId: "exact-aggregate" }));
  expect(Buffer.byteLength(JSON.stringify(input(f, exact.id)))).toBe(8 * 1048576);
});

it("assigns stable distinct aliases to different students", () => {
  const f = fixture();
  f.database.execute("UPDATE marea_runs SET class_id = 'class:one' WHERE id = 'run:c'");
  const report = f.service.reports.generate(teacher, query(f));
  expect(input(f, report.id).sources.map((s) => [s.studentId, s.alias])).toEqual([
    ["s1", "A001"],
    ["s1", "A001"],
    ["s1", "A001"],
    ["s2", "A002"],
  ]);
});

it.each([undefined, { display_name: "A", login: "s" }])(
  "does not corrupt material with missing or one-letter identity fields %#",
  (person) => {
    const f = fixture();
    const read = f.database.readOne.bind(f.database);
    vi.spyOn(f.database, "readOne").mockImplementation((sql, values) =>
      sql.startsWith("SELECT display_name,login") ? person : read(sql, values),
    );
    f.database.execute(
      "UPDATE marea_run_events SET payload_json = ?1 WHERE run_id = 'run:b' AND event_type = 'student-message'",
      [JSON.stringify({ content: "A asks; undefined stays literal" })],
    );
    const report = f.service.reports.generate(teacher, query(f));
    expect(input(f, report.id).sources.find((s) => s.runId === "run:b")?.material).toContain(
      "A asks; undefined stays literal",
    );
  },
);
