import { afterEach } from "vitest";
import { createEducationalMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { InsightsRequestSchema } from "@marea/protocol";
import { evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { LearningProgress } from "./progress.js";
import { EducationalInsightsService } from "./service.js";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
export function fixture() {
  const f = evaluationFixture();
  disposers.push(() => {
    f.database.close();
  });
  for (const migration of createEducationalMigrationCatalog().slice(8))
    for (const sql of migration.statements) f.database.executeScript(sql);
  const progress = new LearningProgress(f.database);
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
    service,
    query,
    now: (value: string) => {
      now = value;
    },
  };
}
