import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { parseOperatorDocument } from "./operator-configuration-parser.js";

const directory = import.meta.dirname;
const example: unknown = JSON.parse(
  readFileSync(join(directory, "operator-configuration.example.json"), "utf8"),
);

it("parses and carries classroom-sized budgets for both purposes", () => {
  const policy = parseOperatorDocument(example).forClass("class:synthetic");
  const budget = policy?.route.providerRoute.budget;
  expect(budget?.inputTokenCeiling).toBe(100_000);
  for (const usage of [budget?.tutoring, budget?.evaluation]) {
    expect(usage).toMatchObject({
      maxRequests: 300,
      maxTokens: 2_000_000,
      maxCostUnits: 4_000_000,
      maxConcurrentRequests: 1,
      maxRequestDurationMs: 120_000,
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      maxToolCalls: 200,
    });
  }
});

it("documents next to the example that limits apply per student session and purpose", () => {
  const readme = readFileSync(join(directory, "README.md"), "utf8").replaceAll(/\s+/gu, " ");
  expect(readme).toContain("not a recommendation");
  expect(readme).toContain("**per student session (one run) and per purpose**");
});
