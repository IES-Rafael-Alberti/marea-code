import { expect, it, vi } from "vitest";
import { MAX_EVALUATION_DRAFT_BYTES } from "@marea/protocol";

import { NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { EVALUATION_OUTPUT_TOKENS } from "./draft-generator.boundary.js";
import { requireClaim, response, setup } from "./draft-generator.fixture.js";
import type { EvaluationDraftDiagnostic } from "./generation-error.js";

it("reports only metadata about a rejected answer, and survives a failing diagnostic sink", async () => {
  const text = "not json";
  const test = setup(response(text), undefined, () => {
    throw new Error("sink down");
  });
  const seen: EvaluationDraftDiagnostic[] = [];
  const recorded = setup(response(text), undefined, (event) => {
    seen.push(event);
  });
  try {
    test.queue();
    expect(await test.worker.runNext(new AbortController().signal)).toBe(true);
    expect(test.repository.latest(teacher, "run:b")).toMatchObject({
      state: "failed",
      failure: "invalid-draft",
    });
    recorded.queue();
    await recorded.worker.runNext(new AbortController().signal);
    expect(seen).toEqual([
      { runId: "run:b", evaluationId: "evaluation:1", reason: "malformed", outputBytes: 8 },
    ]);
  } finally {
    test.database.close();
    recorded.database.close();
  }
});

it("reports oversized streamed output by its reason", async () => {
  const diagnostic = vi.fn<(event: EvaluationDraftDiagnostic) => void>();
  const test = setup(
    [{ type: "text-delta", text: "x".repeat(MAX_EVALUATION_DRAFT_BYTES + 1) }],
    undefined,
    diagnostic,
  );
  try {
    test.queue();
    await test.worker.runNext(new AbortController().signal);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "oversized",
        outputBytes: MAX_EVALUATION_DRAFT_BYTES + 1,
      }),
    );
  } finally {
    test.database.close();
  }
});

it("asks an unlimited budget for room beyond a provider default, which a limited budget caps", async () => {
  const test = setup(response());
  try {
    test.queue();
    const claim = requireClaim(test.repository.claim("worker:unlimited-output", NOW));
    const content = claim.input.content;
    if (content === null) throw new Error("Missing frozen input");
    const budget = content.providerRoute.budget;
    if (budget === undefined) throw new Error("Missing frozen budget");
    await test.generator.generate(
      {
        ...claim,
        input: {
          ...claim.input,
          content: {
            ...content,
            providerRoute: {
              ...content.providerRoute,
              budget: { ...budget, evaluation: { ...budget.evaluation, unlimited: true } },
            },
          },
        },
      },
      new AbortController().signal,
    );
    // Long reasoning sessions outgrew the 8192-token provider default and were truncated.
    expect(EVALUATION_OUTPUT_TOKENS).toBe(32_768);
    // The fallback for a model that declares no maximum, and the request to use the model's own one.
    expect(test.requests[0]?.maxOutputTokens).toBe(EVALUATION_OUTPUT_TOKENS);
    expect(test.requests[0]?.preferModelMaxOutput).toBe(true);
    expect(budget.evaluation.maxOutputTokens).toBeLessThan(EVALUATION_OUTPUT_TOKENS);
  } finally {
    test.database.close();
  }
});

it("does not forward the model-maximum preference under a limited budget, whose policy value applies", async () => {
  const test = setup(response());
  try {
    test.queue();
    await test.worker.runNext(new AbortController().signal);
    expect(test.requests[0]).not.toHaveProperty("preferModelMaxOutput");
    expect(test.requests[0]?.maxOutputTokens).toBe(16_384);
  } finally {
    test.database.close();
  }
});
