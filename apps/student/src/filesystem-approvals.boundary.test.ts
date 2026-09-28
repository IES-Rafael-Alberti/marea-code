import { expect, it } from "vitest";
import { parseStudentState } from "./filesystem.boundary.js";
import { APPROVAL_ID, createFixtureController } from "./student.fixture.js";

it("persists optional rejection reasons up to the UI boundary", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const run = fixture.state.state.run;
  for (const reason of ["", "Explain first", "x".repeat(2048)]) {
    expect(
      parseStudentState({
        run: { ...run, approvals: [{ approvalId: APPROVAL_ID, decision: "rejected", reason }] },
      }).run?.approvals[0]?.reason,
    ).toBe(reason);
  }
  expect(() =>
    parseStudentState({
      run: {
        ...run,
        approvals: [{ approvalId: APPROVAL_ID, decision: "rejected", reason: "x".repeat(2049) }],
      },
    }),
  ).toThrow();
});
