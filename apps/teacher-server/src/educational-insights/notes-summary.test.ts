import { expect, it, vi } from "vitest";
import type * as z from "zod";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { summarizeNotes, summaryRoute, type SummaryInference } from "./notes-summary.js";

const route = summaryRoute(
  { providerId: "p", model: "m", budget: SYNTHETIC_ROUTE_BUDGET },
  { providerId: "p", model: "m" },
);

it("accepts only a trimmed, non-empty summary within the notes bound", async () => {
  const generate = vi.fn<SummaryInference["generate"]>().mockResolvedValue({ summary: "S" });
  const signal = new AbortController().signal;
  expect(await summarizeNotes({ generate }, route, "account", "teacher", "notes", signal)).toBe(
    "S",
  );
  const schema = generate.mock.calls[0]?.[4] as z.ZodType;
  expect(schema.parse({ summary: "  Resumen.  " })).toEqual({ summary: "Resumen." });
  for (const summary of ["", "   ", "x".repeat(200_001)])
    expect(schema.safeParse({ summary }).success).toBe(false);
  expect(schema.safeParse({ summary: "x".repeat(200_000) }).success).toBe(true);
  expect(schema.safeParse({}).success).toBe(false);
  await summarizeNotes({ generate }, route, "account", "session", "notes", signal);
  expect(generate.mock.calls[1]?.[2]).toContain("sesión de tutoría de hoy");
  expect(generate.mock.calls[0]?.[2]).toContain("Propón un resumen breve");
});
