import { TeacherEvaluationSchema } from "@marea/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createEvaluationClient } from "./evaluation-client.boundary.js";
import { DRAFT, HISTORY, NOW, RECORD, SESSIONS, evaluationResponse } from "./evaluation.fixture.js";

const signal = new AbortController().signal;
const approved = TeacherEvaluationSchema.parse({
  ...RECORD,
  state: "approved",
  noticeId: "event:feedback",
  approvedAt: NOW,
});

function setup(value: object) {
  const fetch = vi
    .fn<DashboardFetch>()
    .mockImplementation(() => Promise.resolve(Response.json(value)));
  return { fetch, client: createEvaluationClient(fetch, () => "request:one") };
}

function bodyText(calls: readonly Parameters<DashboardFetch>[], index = -1): string {
  const body = calls.at(index)?.[1].body;
  if (typeof body !== "string") throw new Error("Expected JSON request body.");
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("evaluation dashboard HTTP client", () => {
  it("sends validated same-origin, uncached session and frozen evidence queries", async () => {
    const { client, fetch } = setup(SESSIONS);
    expect(await client.sessions(null, signal)).toEqual(SESSIONS);
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/dashboard/history/sessions", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        requestId: "request:one",
        kind: "session-history-query",
        limit: 50,
      }),
    });
    await client.sessions("run:one", signal);
    expect(JSON.parse(bodyText(fetch.mock.calls))).toMatchObject({
      beforeRunId: "run:one",
    });
    fetch.mockResolvedValueOnce(Response.json(HISTORY));
    expect(await client.history("run:one", 0, undefined, signal)).toEqual(HISTORY);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/dashboard/history/run");
    expect(JSON.parse(bodyText(fetch.mock.calls))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "run-history-query",
      runId: "run:one",
      afterSequence: 0,
      limit: 32,
    });
    fetch.mockResolvedValueOnce(Response.json(HISTORY));
    await client.history("run:one", 0, 2, signal);
    expect(JSON.parse(bodyText(fetch.mock.calls))).toMatchObject({
      throughSequence: 2,
    });
    fetch.mockResolvedValueOnce(Response.json({ ...SESSIONS, runs: [], nextBeforeRunId: null }));
    expect((await client.sessions(null, signal)).runs).toEqual([]);
  });

  it("carries review versions and stable action keys and confirms the exact approved evaluation", async () => {
    const { client, fetch } = setup(evaluationResponse());
    expect(await client.query("run:one", signal)).toEqual(evaluationResponse());
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/dashboard/evaluations/query");
    expect(await client.generate("run:one", null, "generate:1", signal)).toEqual(
      evaluationResponse(),
    );
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/dashboard/evaluations/generate");
    expect(JSON.parse(bodyText(fetch.mock.calls))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "evaluation-generate",
      runId: "run:one",
      expectedEvaluationId: null,
      idempotencyKey: "generate:1",
    });
    await client.generate("run:one", "evaluation:one", "generate:2", signal);
    expect(JSON.parse(bodyText(fetch.mock.calls))).toMatchObject({
      expectedEvaluationId: "evaluation:one",
      idempotencyKey: "generate:2",
    });
    fetch.mockResolvedValueOnce(Response.json(evaluationResponse(approved)));
    expect(await client.approve("run:one", "evaluation:one", DRAFT, "review:1", signal)).toEqual(
      evaluationResponse(approved),
    );
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/dashboard/evaluations/approve");
    expect(JSON.parse(bodyText(fetch.mock.calls))).toEqual({
      protocolVersion: "0.1",
      requestId: "request:one",
      kind: "evaluation-approve-send",
      runId: "run:one",
      evaluationId: "evaluation:one",
      draft: DRAFT,
      idempotencyKey: "review:1",
    });
    fetch.mockResolvedValueOnce(Response.json(evaluationResponse(null)));
    expect((await client.query("run:one", signal)).evaluation).toBeNull();
  });

  it("rejects failed requests, invalid contracts, request mismatches and invalid caller inputs", async () => {
    const { client, fetch } = setup({});
    await expect(client.query("run:one", signal)).rejects.toThrow();
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(client.query("run:one", signal)).rejects.toThrow(
      "The evaluation request failed. Refresh to check its current state.",
    );
    fetch.mockResolvedValueOnce(
      Response.json({ ...evaluationResponse(), requestId: "request:other" }),
    );
    await expect(client.query("run:one", signal)).rejects.toThrow(
      "The evaluation response does not match its request.",
    );
    fetch.mockResolvedValueOnce(
      Response.json(
        evaluationResponse(TeacherEvaluationSchema.parse({ ...RECORD, runId: "run:other" })),
      ),
    );
    await expect(client.query("run:one", signal)).rejects.toThrow(
      "The evaluation belongs to a different run.",
    );
    await expect(client.query("bad/id", signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4);
    fetch.mockResolvedValueOnce(new Response("not JSON"));
    await expect(client.query("run:one", signal)).rejects.toThrow();
  });

  it("rejects crossed history pages, invalid cursors and absent generation or approval confirmations", async () => {
    for (const page of [
      { ...HISTORY, runId: "run:other" },
      {
        ...HISTORY,
        afterSequence: 1,
        nextSequence: null,
        events: [{ ...HISTORY.events[0], sequence: 2 }],
      },
      { ...HISTORY, throughSequence: 3 },
    ]) {
      const { client } = setup(page);
      await expect(client.history("run:one", 0, 2, signal)).rejects.toThrow(
        "The history response does not match its request.",
      );
    }
    for (const runs of [SESSIONS.runs, []]) {
      const { client } = setup({ ...SESSIONS, runs, nextBeforeRunId: "run:other" });
      await expect(client.sessions(null, signal)).rejects.toThrow(
        "The session cursor does not match its page.",
      );
    }
    const { client } = setup(evaluationResponse(null));
    await expect(client.generate("run:one", null, "generate:1", signal)).rejects.toThrow(
      "The generated evaluation is missing.",
    );
    for (const record of [
      null,
      RECORD,
      TeacherEvaluationSchema.parse({ ...approved, evaluationId: "evaluation:other" }),
    ]) {
      const { client: review } = setup(evaluationResponse(record));
      await expect(
        review.approve("run:one", "evaluation:one", DRAFT, "review:1", signal),
      ).rejects.toThrow("The approval response does not confirm the reviewed evaluation.");
    }
  });

  it("generates browser request identifiers by default", async () => {
    const randomUUID = vi.fn(() => "one");
    vi.stubGlobal("crypto", { randomUUID });
    const fetch = vi.fn<DashboardFetch>().mockResolvedValue(Response.json(evaluationResponse()));
    await createEvaluationClient(fetch).query("run:one", signal);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(JSON.parse(bodyText(fetch.mock.calls, 0))).toMatchObject({
      requestId: "request:one",
    });
  });
});
