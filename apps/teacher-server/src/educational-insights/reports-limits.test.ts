import { expect, it, vi } from "vitest";
import * as z from "zod";
import { fixture } from "./insights.fixture.js";
import { input, query, useCeiling } from "./reports.fixture.js";
import { ReportRefusal } from "./reports-model.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";

function sourceRuns(count: number) {
  const f = fixture();
  // Per-run limits apply as documented only when the route ceiling does not lower them.
  useCeiling(f, 1_000_000);
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

it("retains exactly two thousand events without omitting any", () => {
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

it.each([0, 1])("handles report input at exactly eight MiB plus %i bytes", (extra) => {
  const f = sourceRuns(32);
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  let remaining = 8 * 1048576 + extra - Buffer.byteLength(JSON.stringify(frozen));
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
  const attempt = () => f.service.reports.generate(teacher, query(f, { requestId: "aggregate" }));
  if (extra === 1) expect(attempt).toThrow("too-large");
  else expect(Buffer.byteLength(JSON.stringify(input(f, attempt().id)))).toBe(8 * 1048576);
});

it("refuses more than two hundred source runs as too large", () => {
  const f = sourceRuns(201);
  expect(() => f.service.reports.generate(teacher, query(f))).toThrow("too-large");
  expect(f.database.readAll("SELECT id FROM marea_class_reports")).toEqual([]);
});

function longRun(count: number, content: (index: number) => string, ceiling = 1_000_000) {
  const f = sourceRuns(1);
  useCeiling(f, ceiling);
  f.database.execute("DELETE FROM marea_run_events");
  for (let index = 1; index <= count; index++)
    f.database.execute(
      "INSERT INTO marea_run_events VALUES (?1,'run:000',?2,?3,'student-message',?4)",
      [`event:${String(index)}`, index, NOW, JSON.stringify({ content: content(index) })],
    );
  const report = f.service.reports.generate(teacher, query(f));
  const source = input(f, report.id).sources[0];
  const parsed = source?.material
    ? z
        .object({
          events: z.array(z.object({ content: z.string() })),
          omittedEarlierEvents: z.number(),
        })
        .parse(JSON.parse(source.material))
    : undefined;
  return { source, parsed };
}

it("keeps the most recent two thousand events and counts the earlier ones", () => {
  const { parsed, source } = longRun(2500, (index) => `message ${String(index)}`);
  expect(source?.skip).toBeUndefined();
  expect(parsed?.omittedEarlierEvents).toBe(500);
  expect(parsed?.events).toHaveLength(2000);
  expect(parsed?.events[0]?.content).toBe("message 501");
  expect(parsed?.events.at(-1)?.content).toBe("message 2500");
});

it("drops the oldest events of a session that exceeds the byte limit instead of blanking it", () => {
  const { parsed, source } = longRun(
    600,
    (index) => `${String(index).padStart(4, "0")} ${"x".repeat(900)}`,
  );
  const kept = parsed?.events.length ?? 0;
  expect(Buffer.byteLength(source?.material ?? "")).toBeLessThanOrEqual(262144);
  expect(kept).toBeGreaterThan(200);
  expect(kept).toBeLessThan(600);
  expect(parsed?.omittedEarlierEvents).toBe(600 - kept);
  expect(parsed?.events.at(-1)?.content.slice(0, 4)).toBe("0600");
  expect(parsed?.events[0]?.content.slice(0, 4)).toBe(String(600 - kept + 1).padStart(4, "0"));
});

it("marks a session unavailable only when its most recent event alone is too large", () => {
  const { source } = longRun(3, (index) => (index === 3 ? "x".repeat(262144) : "small"));
  expect(source).toMatchObject({ material: "", skip: "material-too-large" });
});

it("does not mark a session without readable events as too large", () => {
  const f = sourceRuns(1);
  f.database.execute("UPDATE marea_run_events SET event_type = 'run-closed'");
  const report = f.service.reports.generate(teacher, query(f));
  expect(input(f, report.id).sources[0]).toMatchObject({ material: "" });
  expect(input(f, report.id).sources[0]?.skip).toBeUndefined();
});

it.each([
  ["from after to", { from: NOW }],
  ["a period over a year", { from: "2020-01-01T00:00:00.000Z" }],
  ["an end beyond the clock tolerance", { to: new Date(Date.parse(NOW) + 300001).toISOString() }],
  [
    "a start not before the clamped end",
    {
      from: new Date(Date.parse(NOW) + 1000).toISOString(),
      to: new Date(Date.parse(NOW) + 2000).toISOString(),
    },
  ],
])("refuses %s as an invalid period", (_label, range) => {
  const f = fixture();
  expect(() => f.service.reports.generate(teacher, query(f, range))).toThrow("invalid-period");
  expect(f.database.readAll("SELECT id FROM marea_class_reports")).toEqual([]);
});

it.each([
  ["a few seconds", 5000],
  ["exactly the tolerance", 300000],
  ["one millisecond", 1],
])("clamps an end ahead of the server clock by %s to the server time", (_label, skew) => {
  const f = fixture();
  const report = f.service.reports.generate(
    teacher,
    query(f, { to: new Date(Date.parse(NOW) + skew).toISOString() }),
  );
  expect(report.to).toBe(NOW);
  expect(input(f, report.id).to).toBe(NOW);
});

it("leaves an end that is not ahead of the clock unchanged", () => {
  const f = fixture();
  const before = new Date(Date.parse(NOW) - 1000).toISOString();
  expect(input(f, f.service.reports.generate(teacher, query(f, { to: before })).id).to).toBe(
    before,
  );
});

it("replays an identical request after clamping and rejects a different end", () => {
  const f = fixture();
  const ahead = new Date(Date.parse(NOW) + 60000).toISOString();
  const first = f.service.reports.generate(teacher, query(f, { to: ahead }));
  expect(f.service.reports.generate(teacher, query(f, { to: ahead })).id).toBe(first.id);
  expect(f.service.reports.generate(teacher, query(f, { to: NOW })).id).toBe(first.id);
  f.now(new Date(Date.parse(NOW) + 3600000).toISOString());
  const edge = new Date(Date.parse(NOW) + 300000).toISOString();
  expect(f.service.reports.generate(teacher, query(f, { to: edge })).id).toBe(first.id);
  const past = new Date(Date.parse(NOW) + 300001).toISOString();
  expect(() => f.service.reports.generate(teacher, query(f, { to: past }))).toThrow(
    "request.conflict",
  );
  expect(() =>
    f.service.reports.generate(
      teacher,
      query(f, { to: new Date(Date.parse(NOW) - 1).toISOString() }),
    ),
  ).toThrow("request.conflict");
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

it("names the refusal and keeps its reason", () => {
  const refusal = new ReportRefusal("too-large");
  expect([refusal.name, refusal.reason, refusal.message]).toEqual([
    "ReportRefusal",
    "too-large",
    "too-large",
  ]);
  expect(refusal).toBeInstanceOf(Error);
});
