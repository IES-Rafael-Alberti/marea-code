import { describe, expect, it } from "vitest";

import { parseStudentState } from "./filesystem.boundary.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds, MemoryStateStore } from "./student.fixture.js";

describe("file student run ownership", () => {
  it("persists optional principal ownership and one bounded abandoned run", async () => {
    const state = new MemoryStateStore();
    const local = new LocalSession(state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    const run = state.state.run;
    if (run === null) throw new Error("Fixture state missing.");
    const foreign = { ...run, userId: "user:one", classId: "class:one" };
    const current = {
      ...run,
      userId: "user:two",
      classId: "class:two",
      abandoned: [foreign],
    };

    expect(parseStudentState({ run: current }).run).toMatchObject({
      userId: "user:two",
      classId: "class:two",
      abandoned: [{ userId: "user:one", classId: "class:one" }],
    });
    expect(parseStudentState({ run }).run).toEqual(run);
    expect(() =>
      parseStudentState({ run: { ...current, abandoned: [foreign, foreign] } }),
    ).toThrow();
  });
});
