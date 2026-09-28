import { expect, it } from "vitest";
import {
  ClassInstructionsSchema,
  completeModeInstructions,
  FREE_INSTRUCTIONS,
  TUTORING_INSTRUCTIONS,
} from "./index.js";

it("pins the shared mode defaults to their accepted version-2 content", () => {
  expect({ tutoring: TUTORING_INSTRUCTIONS, free: FREE_INSTRUCTIONS }).toMatchSnapshot();
});
it("shows defaults for legacy empty fields and preserves both legacy additions exactly", () => {
  expect(completeModeInstructions({ tutoring: "", free: "" })).toEqual({
    format: "complete-mode",
    tutoring: TUTORING_INSTRUCTIONS,
    free: FREE_INSTRUCTIONS,
  });
  const old = { tutoring: "Keep my exercise.\n", free: "Keep my project." };
  expect(completeModeInstructions(old)).toEqual({
    format: "complete-mode",
    tutoring: `${TUTORING_INSTRUCTIONS}\n\n${old.tutoring}`,
    free: `${FREE_INSTRUCTIONS}\n\n${old.free}`,
  });
  expect(old).toEqual({ tutoring: "Keep my exercise.\n", free: "Keep my project." });
});
it("preserves explicitly complete instructions without appending defaults", () => {
  const complete = ClassInstructionsSchema.parse({
    format: "complete-mode",
    tutoring: "Only my tutoring.",
    free: "Only this.",
  });
  expect(completeModeInstructions(complete)).toBe(complete);
  expect(completeModeInstructions(completeModeInstructions({ tutoring: "", free: "" }))).toEqual(
    completeModeInstructions({ tutoring: "", free: "" }),
  );
  for (const format of [null, "additional", 1])
    expect(ClassInstructionsSchema.safeParse({ format, tutoring: "", free: "" }).success).toBe(
      false,
    );
});

it("rejects empty complete instructions but retains legacy empty-field compatibility", () => {
  for (const [tutoring, free] of [
    ["", "Valid"],
    ["Valid", ""],
    ["", ""],
  ])
    expect(
      ClassInstructionsSchema.safeParse({ format: "complete-mode", tutoring, free }).success,
    ).toBe(false);
  expect(ClassInstructionsSchema.safeParse({ tutoring: "", free: "" }).success).toBe(true);
});

it("reports why complete mode fields cannot be empty", () => {
  const result = ClassInstructionsSchema.safeParse({
    format: "complete-mode",
    tutoring: "",
    free: "Valid",
  });
  expect(result.error?.issues[0]?.message).toBe("Complete mode instructions must not be empty.");
});
