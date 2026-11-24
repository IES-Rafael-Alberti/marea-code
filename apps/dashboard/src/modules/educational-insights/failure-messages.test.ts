import { expect, it } from "vitest";
import { failureMessages } from "./failure-messages.js";
import { insightsMessages } from "./messages.js";

const CODES = [
  "analysis-failed",
  "output-invalid",
  "input-too-large",
  "budget",
  "provider",
  "deadline",
  "unconfigured",
  "access-revoked",
  "interrupted",
  "evidence-deleted",
];
const REASONS = [
  "no-material",
  "material-too-large",
  "no-criteria",
  "output-invalid",
  "input-too-large",
  "budget",
  "provider",
  "deadline",
  "unconfigured",
];
const REFUSALS = ["reportTooLarge", "reportInProgress", "reportPeriod"] as const;

it.each(["en", "es", "eu"] as const)("explains every failure code and reason in %s", (locale) => {
  const { failures, reasons } = failureMessages(locale);
  expect(Object.keys(failures)).toEqual(CODES);
  expect(Object.keys(reasons)).toEqual(REASONS);
  for (const text of [...Object.values(failures), ...Object.values(reasons)])
    expect(text.trim().length).toBeGreaterThan(10);
});

it("localizes each message distinctly and selects the locale", () => {
  const texts = (["en", "es", "eu"] as const).map((locale) => {
    const messages = failureMessages(locale);
    const refusals = REFUSALS.map((key) => insightsMessages(locale)[key]);
    return [...Object.values(messages.failures), ...Object.values(messages.reasons), ...refusals];
  });
  const [en, es, eu] = texts;
  expect(en?.some((text, index) => text === es?.[index] || text === eu?.[index])).toBe(false);
  expect(new Set(en).size).toBe(en?.length);
  expect(failureMessages("en").failures.budget).toContain("budget");
  expect(failureMessages("es").failures.budget).toContain("presupuesto");
  expect(failureMessages("eu").failures.budget).toContain("aurrekontua");
});

it("names a distinct problem and remedy for each refused generate request", () => {
  expect(insightsMessages("en").reportTooLarge).toContain("shorter period");
  expect(insightsMessages("en").reportInProgress).toContain("already in progress");
  expect(insightsMessages("en").reportPeriod).toContain("device clock");
  expect(insightsMessages("es").reportTooLarge).toContain("periodo más corto");
  expect(insightsMessages("eu").reportInProgress).toContain("abian dago");
});
