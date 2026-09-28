import { describe, expect, it, vi } from "vitest";
import { evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { createEvaluationModule } from "./evaluation-module.js";
import { EvaluationGenerationError } from "./generation-error.js";

describe("evaluation composition lifecycle", () => {
  it("cancels the host timer when stopped", async () => {
    vi.useFakeTimers();
    const test = evaluationFixture();
    try {
      const module = createEvaluationModule({
        repository: test.repository,
        ledger: new SqliteUsageLedger(test.database),
        clock: { now: () => NOW },
        ids: { createId: () => "event:module" },
        createReservationId: () => "reservation:module",
        providers: { resolve: () => undefined },
        intervalMs: 10,
        onError: vi.fn(),
      });
      module.start();
      expect(vi.getTimerCount()).toBe(1);
      await module.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      test.database.close();
    }
  });
  it("uses a fixed safe error without provider or evidence details", () => {
    expect(new EvaluationGenerationError("invalid-draft")).toMatchObject({
      name: "EvaluationGenerationError",
      message: "The evaluation could not produce a reviewable draft.",
      code: "invalid-draft",
    });
  });
});
