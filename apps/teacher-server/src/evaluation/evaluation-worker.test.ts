import type { EvaluationDraft } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { EVALUATION_DRAFT, evaluationFixture, NOW } from "../../test-support/evaluation-fixture.js";
import type { EvaluationClaim } from "./contracts.js";
import { EVALUATION_CONCURRENCY, EvaluationWorker } from "./evaluation-worker.js";

/** A repository that hands each queued evaluation to exactly one caller, in order. */
function setup(
  queued: number,
  generate: (claim: EvaluationClaim, signal: AbortSignal) => Promise<EvaluationDraft>,
) {
  const fixture = evaluationFixture();
  fixture.queue();
  const template = fixture.repository.claim("worker:template", NOW);
  if (template === null) throw new Error("Expected a template claim");
  let next = 0;
  const claim = vi.spyOn(fixture.repository, "claim").mockImplementation((workerToken) =>
    next < queued
      ? ({
          ...template,
          evaluationId: `evaluation:${String(next++)}`,
          workerToken,
        } satisfies EvaluationClaim)
      : null,
  );
  const finish = vi.spyOn(fixture.repository, "finish").mockImplementation(() => {
    // Results are observed through the spy instead of being stored.
  });
  let id = 0;
  const worker = new EvaluationWorker({
    repository: fixture.repository,
    generator: { generate },
    clock: { now: () => NOW },
    ids: { createId: () => `event:${String(++id)}` },
  });
  return {
    claim,
    finish,
    worker,
    close: () => {
      fixture.database.close();
    },
  };
}

describe("evaluation worker batches", () => {
  it("evaluates at most four queued evaluations at once, each claimed exactly once", async () => {
    expect(EVALUATION_CONCURRENCY).toBe(4);
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const test = setup(6, async (claim) => {
      started.push(claim.evaluationId);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return EVALUATION_DRAFT;
    });
    try {
      const batch = test.worker.runBatch(new AbortController().signal);
      await vi.waitFor(() => {
        expect(releases).toHaveLength(4);
      });
      expect(started).toEqual(["evaluation:0", "evaluation:1", "evaluation:2", "evaluation:3"]);
      expect(test.claim).toHaveBeenCalledTimes(4);
      for (const release of releases) release();
      expect(await batch).toBe(4);
      expect(peak).toBe(4);
      expect(test.finish.mock.calls.map(([claim]) => claim.evaluationId)).toEqual(started);
      // The remaining two are picked up by the next tick, never twice.
      const second = test.worker.runBatch(new AbortController().signal);
      await vi.waitFor(() => {
        expect(releases).toHaveLength(6);
      });
      releases.slice(4).forEach((release) => {
        release();
      });
      expect(await second).toBe(2);
      expect(test.finish).toHaveBeenCalledTimes(6);
    } finally {
      test.close();
    }
  });

  it("reports only the evaluations it actually ran", async () => {
    const test = setup(2, () => Promise.resolve(EVALUATION_DRAFT));
    try {
      expect(await test.worker.runBatch(new AbortController().signal)).toBe(2);
      expect(test.finish).toHaveBeenCalledTimes(2);
      expect(await test.worker.runBatch(new AbortController().signal)).toBe(0);
    } finally {
      test.close();
    }
  });

  it("claims nothing once cancelled", async () => {
    const test = setup(3, () => Promise.resolve(EVALUATION_DRAFT));
    try {
      const controller = new AbortController();
      controller.abort();
      expect(await test.worker.runBatch(controller.signal)).toBe(0);
      expect(test.claim).not.toHaveBeenCalled();
    } finally {
      test.close();
    }
  });

  it("lets every started evaluation settle before it reports a storage failure", async () => {
    let settled = 0;
    const test = setup(4, async () => {
      await Promise.resolve();
      settled += 1;
      return EVALUATION_DRAFT;
    });
    try {
      test.finish.mockImplementationOnce(() => {
        throw new Error("storage failed");
      });
      await expect(test.worker.runBatch(new AbortController().signal)).rejects.toThrow(
        "storage failed",
      );
      expect(settled).toBe(4);
      expect(test.finish).toHaveBeenCalledTimes(4);
    } finally {
      test.close();
    }
  });
});
