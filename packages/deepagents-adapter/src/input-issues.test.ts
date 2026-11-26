import { expect, it } from "vitest";
import * as z from "zod";

import { describeIssues } from "./input-issues.js";

function failure(schema: z.ZodType, value: number | object): z.ZodError {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("Expected a failure.");
  return parsed.error;
}

it("names the parameter of each problem and separates the problems", () => {
  const schema = z.object({ path: z.string(), nested: z.object({ name: z.string() }) });
  expect(describeIssues(failure(schema, { nested: {} }))).toBe(
    "path: Invalid input: expected string, received undefined; nested.name: Invalid input: expected string, received undefined",
  );
});

it("gives a problem with no parameter as its message alone", () => {
  expect(describeIssues(failure(z.string(), 1))).toBe(
    "Invalid input: expected string, received number",
  );
});
