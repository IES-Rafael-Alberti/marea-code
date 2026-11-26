import { afterEach, vi } from "vitest";
import { createLearningNotesMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { InsightsRequestSchema } from "@marea/protocol";
import { evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { EducationalInsightsService } from "./service.js";
import type { ReportDiagnostic } from "./reports.js";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
export function fixture() {
  const f = evaluationFixture();
  disposers.push(() => {
    f.database.close();
  });
  for (const migration of createLearningNotesMigrationCatalog().slice(8))
    for (const sql of migration.statements) f.database.executeScript(sql);
  let now = NOW;
  const route = {
    providerId: "synthetic-provider",
    model: "synthetic-model",
    budget: SYNTHETIC_ROUTE_BUDGET.evaluation,
    inputTokenCeiling: 65536,
  };
  const service = new EducationalInsightsService(
    f.database,
    { now: () => now },
    { resolve: () => undefined },
    { map: route, reports: route },
  );
  const progress = service.progress;
  const diagnostics = vi.fn<(entry: ReportDiagnostic) => void>();
  service.reports.diagnostics = diagnostics;
  const query = (input: object) =>
    InsightsRequestSchema.parse({
      classId: "class:one",
      protocolVersion: "0.1",
      requestId: "request:insight",
      ...input,
    });
  return {
    ...f,
    progress,
    route,
    service,
    diagnostics,
    query,
    now: (value: string) => {
      now = value;
    },
  };
}
