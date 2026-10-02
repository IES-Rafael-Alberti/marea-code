import type {
  InferenceCancellation,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";
import { describe, expect, it, vi } from "vitest";

import {
  EVALUATION_DRAFT,
  evaluationFixture,
  NOW,
  teacher,
} from "../../test-support/evaluation-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { SqliteNoticeRepository } from "../platform/persistence/sqlite-notice-repository.js";
import { EvaluationDraftGenerator } from "./draft-generator.boundary.js";
import { EvaluationWorker } from "./evaluation-worker.js";
import type { EvaluationClaim } from "./contracts.js";
import { EventIdSchema, MAX_EVALUATION_DRAFT_BYTES } from "@marea/protocol";
import { MAX_EVALUATION_INPUT_BYTES } from "./evaluation-input.js";

function setup(
  events: readonly InferenceProviderEvent[],
  onRequest?: (signal: InferenceCancellation) => void,
) {
  const test = evaluationFixture();
  const requests: InferenceProviderRequest[] = [];
  const ledger = new SqliteUsageLedger(test.database);
  let id = 0;
  const clock = { now: () => NOW };
  const generator = new EvaluationDraftGenerator({
    ledger,
    clock,
    createReservationId: () => `reservation:${String(++id)}`,
    providers: {
      resolve: () => ({
        async *stream(request, signal) {
          requests.push(request);
          onRequest?.(signal);
          await Promise.resolve();
          yield* events;
        },
      }),
    },
  });
  const worker = new EvaluationWorker({
    repository: test.repository,
    generator,
    clock,
    ids: { createId: (namespace) => `${namespace}:${String(++id)}` },
  });
  return { ...test, requests, ledger, generator, worker };
}

function response(
  text = JSON.stringify(EVALUATION_DRAFT),
  finishReason: "stop" | "length" = "stop",
): readonly InferenceProviderEvent[] {
  return [
    { type: "text-delta", text: text.slice(0, 17) },
    { type: "text-delta", text: text.slice(17) },
    { type: "usage", inputTokens: 10, outputTokens: 20 },
    { type: "completed", finishReason },
  ];
}

function requireClaim(claim: EvaluationClaim | null): EvaluationClaim {
  if (claim === null) throw new Error("Expected evaluation claim.");
  return claim;
}

describe("budgeted private evaluation generation", () => {
  it("admits exact model-input bytes to budget admission and rejects the next byte first", async () => {
    const test = setup(response());
    try {
      test.queue();
      const claim = requireClaim(test.repository.claim("worker:boundary", NOW));
      const content = claim.input.content;
      if (content === null) throw new Error("Expected frozen material");
      await test.generator.generate(claim, new AbortController().signal);
      const request = test.requests[0];
      if (request === undefined) throw new Error("Expected provider request");
      const bytes = request.messages.reduce(
        (sum, message) => sum + Buffer.byteLength(message.content),
        0,
      );
      const budgetAdmission = new Error("Synthetic budget admission");
      const configure = vi.spyOn(test.ledger, "configure").mockImplementation(() => {
        throw budgetAdmission;
      });
      for (const extra of [0, 1]) {
        const events = content.events.map((event) =>
          event.eventType === "student-message"
            ? {
                ...event,
                content: event.content + "x".repeat(MAX_EVALUATION_INPUT_BYTES - bytes + extra),
              }
            : event,
        );
        await expect(
          test.generator.generate(
            { ...claim, input: { ...claim.input, content: { ...content, events } } },
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          extra === 0 ? budgetAdmission : "The evaluation could not produce a reviewable draft.",
        );
      }
      expect(configure).toHaveBeenCalledOnce();
    } finally {
      test.database.close();
    }
  });
  it("accepts a valid JSON response at the exact streamed byte limit", async () => {
    const json = JSON.stringify(EVALUATION_DRAFT);
    const text = json + " ".repeat(MAX_EVALUATION_DRAFT_BYTES - Buffer.byteLength(json));
    const test = setup(response(text));
    try {
      test.queue();
      await test.worker.runNext(new AbortController().signal);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "draft",
        draft: EVALUATION_DRAFT,
      });
      expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" }).tokens).toBe(30);
    } finally {
      test.database.close();
    }
  });
  it("rejects oversized model input before reservation and oversized streamed output without publication", async () => {
    const json = JSON.stringify(EVALUATION_DRAFT);
    const test = setup(
      response(json + " ".repeat(MAX_EVALUATION_DRAFT_BYTES + 1 - Buffer.byteLength(json))),
    );
    try {
      test.queue();
      const claim = requireClaim(test.repository.claim("worker:input", NOW));
      const content = claim.input.content;
      if (content === null) throw new Error("Expected frozen material");
      const event = {
        eventType: "student-message" as const,
        eventId: EventIdSchema.parse("event:oversized"),
        occurredAt: NOW,
        sequence: 1,
        content: "x".repeat(MAX_EVALUATION_INPUT_BYTES),
      };
      await expect(
        test.generator.generate(
          { ...claim, input: { ...claim.input, content: { ...content, events: [event] } } },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "input-too-large" });
      expect(test.requests).toEqual([]);
      expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" }).requests).toBe(0);
      await expect(
        test.generator.generate(claim, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid-draft" });
      expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" })).toMatchObject({
        requests: 1,
        inFlight: 0,
        tokens: 81_920,
      });
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
    } finally {
      test.database.close();
    }
  });

  it("records interruption even when a generator resolves after ignoring cancellation", async () => {
    const test = evaluationFixture();
    const controller = new AbortController();
    try {
      test.queue();
      const worker = new EvaluationWorker({
        repository: test.repository,
        clock: { now: () => NOW },
        ids: { createId: () => "worker:ignored" },
        generator: {
          generate: () => {
            controller.abort();
            return Promise.resolve(EVALUATION_DRAFT);
          },
        },
      });
      expect(await worker.runNext(controller.signal)).toBe(true);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "failed",
        failure: "interrupted",
      });
    } finally {
      test.database.close();
    }
  });
  it("uses frozen method and conversation with an independent budget, no tools and no student delivery", async () => {
    const test = setup(response());
    try {
      test.queue();
      const claim = vi.spyOn(test.repository, "claim");
      expect(await test.worker.runNext(new AbortController().signal)).toBe(true);
      expect(claim).toHaveBeenNthCalledWith(1, "event:1", NOW);
      expect(await test.worker.runNext(new AbortController().signal)).toBe(false);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "draft",
        draft: EVALUATION_DRAFT,
      });
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]).toMatchObject({
        requestId: "evaluation:1",
        upstreamModel: "synthetic-model",
        maxOutputTokens: 16_384,
        tools: [],
        messages: [{ role: "system" }, { role: "user" }],
      });
      expect(test.requests[0]?.messages[0]?.content).toContain(
        "private evaluation for a human teacher",
      );
      expect(test.requests[0]?.messages[0]?.content).toContain("JSON schema:");
      const material = test.requests[0]?.messages[1]?.content;
      expect(material).toContain("Synthetic evaluation instructions");
      expect(material).toContain("Frozen didactic resource");
      expect(material).toContain("Let us test an empty input");
      expect(material).not.toContain("providerRoute");
      expect(test.ledger.totals({ runId: "run:b", purpose: "tutoring" })).toEqual({
        requests: 0,
        tokens: 0,
        costUnits: 0,
        inFlight: 0,
      });
      expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" })).toEqual({
        requests: 1,
        tokens: 30,
        costUnits: 80,
        inFlight: 0,
      });
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
    } finally {
      test.database.close();
    }
  });

  it.each([
    [response("not json"), "invalid-draft"],
    [response("{}"), "invalid-draft"],
    [response(JSON.stringify({ ...EVALUATION_DRAFT, approved: true })), "invalid-draft"],
    [response(JSON.stringify(EVALUATION_DRAFT), "length"), "invalid-draft"],
    [
      [
        {
          type: "tool-call",
          callId: "call:bad",
          name: "execute",
          arguments: { command: "never run" },
        },
      ],
      "invalid-draft",
    ],
    [[], "inference-failed"],
  ] as const)(
    "stores a safe failure for an unusable provider response %#",
    async (events, failure) => {
      const test = setup(events);
      try {
        test.queue();
        expect(await test.worker.runNext(new AbortController().signal)).toBe(true);
        expect(test.repository.latest(teacher, "run:b")).toMatchObject({
          state: "failed",
          failure,
        });
        expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
        expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" }).requests).toBe(1);
      } finally {
        test.database.close();
      }
    },
  );

  it("does not claim pre-cancelled work and records interruption during generation", async () => {
    const controller = new AbortController();
    const test = setup(response(), () => {
      controller.abort();
    });
    try {
      test.queue();
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await test.worker.runNext(cancelled.signal)).toBe(false);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({ state: "queued" });
      expect(test.requests).toEqual([]);
      expect(await test.worker.runNext(controller.signal)).toBe(true);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "failed",
        failure: "interrupted",
      });
      expect(test.ledger.totals({ runId: "run:b", purpose: "evaluation" })).toMatchObject({
        requests: 1,
        tokens: 81_920,
        inFlight: 0,
      });
    } finally {
      test.database.close();
    }
  });

  it("rejects unavailable configuration and uncaptured input before inference", async () => {
    const test = setup(response());
    try {
      test.queue();
      const claim = requireClaim(test.repository.claim("worker:1", NOW));
      await expect(
        test.generator.generate(
          { ...claim, input: { ...claim.input, content: null } },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "input-too-large" });
      const unavailable = new EvaluationDraftGenerator({
        ledger: test.ledger,
        clock: { now: () => NOW },
        createReservationId: () => "unused",
        providers: { resolve: () => undefined },
      });
      await expect(unavailable.generate(claim, new AbortController().signal)).rejects.toMatchObject(
        { code: "unconfigured" },
      );
      const content = claim.input.content;
      if (content === null) throw new Error("Expected frozen input.");
      await expect(
        test.generator.generate(
          {
            ...claim,
            input: {
              ...claim.input,
              content: {
                ...content,
                providerRoute: { providerId: "synthetic-provider", model: "synthetic-model" },
              },
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "unconfigured" });
      expect(test.requests).toEqual([]);
    } finally {
      test.database.close();
    }
  });
});
it("evaluates canonical project evidence without feeding model diagnostics or streaming duplicates back into grading", async () => {
  const test = setup(response());
  try {
    test.queue();
    const claim = requireClaim(test.repository.claim("worker:evidence", NOW));
    const content = claim.input.content;
    if (content === null) throw new Error("Expected frozen content");
    const { CanonicalRunEventSchema } = await import("@marea/protocol");
    const event = (payload: object, index: number) =>
      CanonicalRunEventSchema.parse({
        eventId: `event:extra:${String(index)}`,
        sequence: index + 100,
        occurredAt: NOW,
        ...payload,
      });
    const extra = [
      event(
        {
          eventType: "model-diagnostic",
          requestId: "request:diagnostic",
          phase: "request",
          status: "started",
          content: "PRIVATE_RAW_PROMPT",
          truncated: false,
        },
        0,
      ),
      event(
        {
          eventType: "assistant-progress",
          messageId: "message:evidence",
          content: "DUPLICATED_PREFIX",
          truncated: false,
        },
        1,
      ),
      event(
        {
          eventType: "project-change",
          actor: "student",
          summary: "Student authored this",
          patch: "+ACTUAL_STUDENT_CHANGE",
          truncated: false,
        },
        2,
      ),
    ];
    await test.generator.generate(
      {
        ...claim,
        input: { ...claim.input, content: { ...content, events: [...content.events, ...extra] } },
      },
      new AbortController().signal,
    );
    const material = JSON.stringify(test.requests[0]?.messages);
    expect(material).not.toContain("PRIVATE_RAW_PROMPT");
    expect(material).not.toContain("DUPLICATED_PREFIX");
    expect(material).toContain("ACTUAL_STUDENT_CHANGE");
  } finally {
    test.database.close();
  }
});

it("uses the separately frozen evaluation model while retaining the evaluation budget", async () => {
  const test = setup(response());
  try {
    test.queue();
    const claim = requireClaim(test.repository.claim("worker:separate-model", NOW));
    const content = claim.input.content;
    if (content === null) throw new Error("Missing frozen input");
    await test.generator.generate(
      {
        ...claim,
        input: {
          ...claim.input,
          content: {
            ...content,
            providerRoute: {
              ...content.providerRoute,
              evaluation: { providerId: "synthetic.evaluator", model: "evaluation-model" },
            },
          },
        },
      },
      new AbortController().signal,
    );
    expect(test.requests[0]?.upstreamModel).toBe("evaluation-model");
    expect(content.providerRoute.model).not.toBe("evaluation-model");
  } finally {
    test.database.close();
  }
});
