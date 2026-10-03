import { expect, it } from "vitest";
import { teacher } from "../../test-support/evaluation-fixture.js";
import { fixture } from "./insights.fixture.js";

function report(f: ReturnType<typeof fixture>, id: string, createdAt: string, input: object) {
  f.database.execute(
    "INSERT INTO marea_class_reports (id,class_id,owner_id,request_id,created_at,state,input_json) VALUES (?1,'class:one',?2,?1,?3,'complete',?4)",
    [id, teacher.userId, createdAt, JSON.stringify(input)],
  );
}

it("lists reports newest first with their period and progress, paging by date", () => {
  const f = fixture();
  const input = {
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-08T00:00:00.000Z",
    sources: [1, 2],
  };
  // Random identifiers sort against creation order, so only the date can order the list.
  report(f, "z-oldest", "2026-09-10T08:00:00.000Z", input);
  report(f, "a-newest", "2026-09-12T08:00:00.000Z", input);
  report(f, "m-middle", "2026-09-11T08:00:00.000Z", {});
  f.database.execute("UPDATE marea_class_reports SET completed = 1 WHERE id = 'a-newest'");
  const list = f.service.reports.list("class:one", null);
  expect(list.map((entry) => entry.id)).toEqual(["a-newest", "m-middle", "z-oldest"]);
  expect(list[0]).toMatchObject({
    state: "complete",
    createdAt: "2026-09-12T08:00:00.000Z",
    from: input.from,
    to: input.to,
    completed: 1,
    total: 2,
  });
  // A report whose evidence was removed keeps an entry without a period.
  expect(list[1]).toMatchObject({ from: "", to: "", completed: 0, total: 0 });
  expect(f.service.reports.list("class:one", "a-newest").map((entry) => entry.id)).toEqual([
    "m-middle",
    "z-oldest",
  ]);
  expect(f.service.reports.list("class:other", null)).toEqual([]);
  expect(f.service.reports.list("class:other", "a-newest")).toEqual([]);
});

it("breaks ties in creation time by identifier and never repeats a report across pages", () => {
  const f = fixture();
  for (const id of ["b", "c", "a"]) report(f, id, "2026-09-10T08:00:00.000Z", {});
  expect(f.service.reports.list("class:one", null).map((entry) => entry.id)).toEqual([
    "c",
    "b",
    "a",
  ]);
  expect(f.service.reports.list("class:one", "b").map((entry) => entry.id)).toEqual(["a"]);
});
