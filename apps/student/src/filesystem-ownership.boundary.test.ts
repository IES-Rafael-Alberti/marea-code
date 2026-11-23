import { describe, expect, it } from "vitest";

import { parseStudentState } from "./filesystem.boundary.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds, MemoryStateStore } from "./student.fixture.js";

describe("file student run set-aside state", () => {
  it("persists one bounded abandoned run and keeps legacy state valid", async () => {
    const state = new MemoryStateStore();
    const local = new LocalSession(state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    const run = state.state.run;
    if (run === null) throw new Error("Fixture state missing.");
    const current = { ...run, abandoned: [run] };

    expect(parseStudentState({ run: current }).run).toMatchObject({ abandoned: [run] });
    expect(parseStudentState({ run }).run).toEqual(run);
    expect(() => parseStudentState({ run: { ...current, abandoned: [run, run] } })).toThrow();
  });
});
