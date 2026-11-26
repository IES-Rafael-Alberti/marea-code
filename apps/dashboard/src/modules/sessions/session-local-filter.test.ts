import { expect, it } from "vitest";
import { ClassSessionItemSchema } from "@marea/protocol";
import { SESSIONS, NO_REVIEW } from "../evaluation/evaluation.fixture.js";
import { normalizedFilters, sessionMatchesFilters } from "./session-local-filter.js";

const base = SESSIONS.runs[0];
const run = (patch: object = {}) =>
  ClassSessionItemSchema.parse({
    ...base,
    classId: "class:one",
    studentDisplayName: "Álvaro Núñez",
    projectDisplayName: "Diseño web",
    state: "closed",
    review: { ...NO_REVIEW, evaluation: "draft", criteria: 2, evidenced: 1 },
    ...patch,
  });

it("lets every row through when nothing filters", () => {
  expect(sessionMatchesFilters(run(), {})).toBe(true);
});
it("searches the names apart, ignoring case and accents", () => {
  expect(sessionMatchesFilters(run(), { search: "ALVARO" })).toBe(true);
  expect(sessionMatchesFilters(run(), { search: "diseno" })).toBe(true);
  expect(sessionMatchesFilters(run(), { search: "nunez diseno" })).toBe(false);
  expect(sessionMatchesFilters(run(), { search: "zeta" })).toBe(false);
});
it("filters by session state", () => {
  expect(sessionMatchesFilters(run(), { runState: "closed" })).toBe(true);
  expect(sessionMatchesFilters(run(), { runState: "active" })).toBe(false);
});
it("filters by evaluation state", () => {
  expect(sessionMatchesFilters(run(), { evaluation: ["draft", "failed"] })).toBe(true);
  expect(sessionMatchesFilters(run(), { evaluation: ["approved"] })).toBe(false);
});
it("filters by evidence, leaving a draft that assessed nothing undetermined", () => {
  const withEvidence = run();
  const without = run({ review: { ...NO_REVIEW, evaluation: "draft", criteria: 2 } });
  const undetermined = run({ review: { ...NO_REVIEW, evaluation: "draft" } });
  expect(sessionMatchesFilters(withEvidence, { evidence: "with" })).toBe(true);
  expect(sessionMatchesFilters(withEvidence, { evidence: "without" })).toBe(false);
  expect(sessionMatchesFilters(without, { evidence: "with" })).toBe(false);
  expect(sessionMatchesFilters(without, { evidence: "without" })).toBe(true);
  expect(sessionMatchesFilters(undetermined, { evidence: "with" })).toBe(false);
  expect(sessionMatchesFilters(undetermined, { evidence: "without" })).toBe(false);
});
it("keeps a row without a review summary for the server to settle", () => {
  const unreviewed = run({ review: undefined });
  expect(sessionMatchesFilters(unreviewed, { evaluation: ["approved"], evidence: "with" })).toBe(
    true,
  );
  expect(sessionMatchesFilters(unreviewed, { runState: "active" })).toBe(false);
});
it("normalizes the search like the server: trimmed, capped, dropped when blank", () => {
  expect(normalizedFilters({ runState: "closed", search: "  Ada  " })).toEqual({
    runState: "closed",
    search: "Ada",
  });
  expect(normalizedFilters({ search: ` ${"a".repeat(100)} ` }).search).toBe("a".repeat(80));
  expect(normalizedFilters({ search: "   " })).toEqual({ search: undefined });
  expect(normalizedFilters({})).toEqual({ search: undefined });
});
