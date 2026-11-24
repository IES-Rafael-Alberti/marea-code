import { describe, expect, it, vi } from "vitest";
import { evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { createEvaluationModule } from "./evaluation-module.js";
import { EvaluationGenerationError } from "./generation-error.js";

function moduleOptions(test: ReturnType<typeof evaluationFixture>, closeAbandonedRuns = vi.fn()) {
  return {
    repository: test.repository,
    ledger: new SqliteUsageLedger(test.database),
    clock: { now: () => NOW },
    ids: { createId: () => "event:module" },
    createReservationId: () => "reservation:module",
    providers: { resolve: () => undefined },
    intervalMs: 10,
    closeAbandonedRuns,
    onError: vi.fn(),
  };
}

describe("evaluation composition lifecycle", () => {
  it("cancels the host timer when stopped", async () => {
    vi.useFakeTimers();
    const test = evaluationFixture();
    try {
      const module = createEvaluationModule(moduleOptions(test));
      module.start();
      expect(vi.getTimerCount()).toBe(1);
      await module.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      test.database.close();
    }
  });
  it("closes abandoned runs once at startup and again before every scheduled tick", async () => {
    vi.useFakeTimers();
    const test = evaluationFixture();
    try {
      const closeAbandonedRuns = vi.fn(() => 0);
      const module = createEvaluationModule(moduleOptions(test, closeAbandonedRuns));
      module.recoverAfterExclusiveStartup();
      expect(closeAbandonedRuns).toHaveBeenCalledTimes(1);
      module.start();
      expect(closeAbandonedRuns).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(closeAbandonedRuns).toHaveBeenCalledTimes(2);
      await module.stop();
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
