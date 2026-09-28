import { TeacherEvaluationSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { EvaluationController } from "./evaluation-controller.js";
import {
  DRAFT,
  HISTORY,
  RECORD,
  SESSIONS,
  evaluationClientFixture,
  evaluationResponse,
} from "./evaluation.fixture.js";

function setup() {
  const client = evaluationClientFixture();
  const changed = vi.fn();
  const keys = vi.fn(() => "action:one");
  return { client, changed, keys, controller: new EvaluationController(client, changed, keys) };
}

describe("evaluation review controller", () => {
  it("creates browser action keys when no key source is supplied", async () => {
    const client = evaluationClientFixture();
    const randomUUID = vi.fn(() => "one");
    vi.stubGlobal("crypto", { randomUUID });
    try {
      const controller = new EvaluationController(client, vi.fn());
      await controller.select("run:one");
      await controller.generate();
      expect(randomUUID).toHaveBeenCalledOnce();
      expect(client.generate).toHaveBeenCalledWith(
        "run:one",
        "evaluation:one",
        "evaluation:one",
        expect.any(AbortSignal),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("loads bounded pages, selects evidence and discards local edits on explicit refresh", async () => {
    const { controller, client } = setup();
    await controller.refresh();
    await controller.nextHistory();
    await controller.generate();
    await controller.approve();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.generate).not.toHaveBeenCalled();
    expect(client.approve).not.toHaveBeenCalled();
    await controller.loadSessions();
    expect(client.sessions).toHaveBeenLastCalledWith(null, expect.any(AbortSignal));
    expect(controller.state.sessions).toEqual(SESSIONS);
    await controller.loadSessions("run:one");
    expect(client.sessions).toHaveBeenLastCalledWith("run:one", expect.any(AbortSignal));
    await controller.select("run:one");
    expect(controller.state).toMatchObject({
      busy: false,
      error: false,
      history: HISTORY,
      evaluation: RECORD,
      draft: DRAFT,
      uncertain: false,
    });
    expect(client.history).toHaveBeenLastCalledWith(
      "run:one",
      0,
      undefined,
      expect.any(AbortSignal),
    );
    controller.edit({ ...DRAFT, teacherNote: "Local changes" });
    expect(controller.state.draft?.teacherNote).toBe("Local changes");
    await controller.nextHistory();
    expect(client.history).toHaveBeenLastCalledWith("run:one", 1, 2, expect.any(AbortSignal));
    await controller.refresh();
    expect(controller.state.draft).toEqual(DRAFT);
    expect(client.query).toHaveBeenCalledTimes(2);
    client.history.mockResolvedValueOnce({ ...HISTORY, nextSequence: null });
    await controller.refresh();
    const calls = client.history.mock.calls.length;
    await controller.nextHistory();
    expect(client.history).toHaveBeenCalledTimes(calls);
  });

  it("retries a lost approval with exactly the reviewed body and action key, without further editing", async () => {
    const { controller, client, keys } = setup();
    await controller.select("run:one");
    const reviewed = {
      ...DRAFT,
      studentFeedback: "  Reviewed public text  ",
      difficulties: [" ", "  A difficulty  ", ""],
    };
    controller.edit(reviewed);
    client.approve.mockRejectedValueOnce(new Error("response lost"));
    await controller.approve();
    expect(controller.state).toMatchObject({
      error: true,
      uncertain: true,
      pendingKind: "approve",
      busy: false,
    });
    controller.edit({ ...DRAFT, studentFeedback: "Do not send this" });
    expect(controller.state.draft).toEqual(reviewed);
    await controller.generate();
    expect(client.generate).not.toHaveBeenCalled();
    await controller.approve();
    expect(client.approve).toHaveBeenCalledTimes(2);
    expect(client.approve.mock.calls[0]).toEqual(client.approve.mock.calls[1]);
    expect(client.approve.mock.calls[0]?.slice(0, 4)).toEqual([
      "run:one",
      "evaluation:one",
      { ...reviewed, studentFeedback: "Reviewed public text", difficulties: ["A difficulty"] },
      "action:one",
    ]);
    expect(keys).toHaveBeenCalledOnce();
    expect(controller.state).toMatchObject({
      uncertain: false,
      pendingKind: null,
      error: false,
      evaluation: { state: "approved" },
    });
    const approvedDraft = controller.state.draft;
    controller.edit(DRAFT);
    expect(controller.state.draft).toBe(approvedDraft);
    await controller.approve();
    expect(client.approve).toHaveBeenCalledTimes(2);
  });

  it("keeps regeneration retries separate from approval, then clears approval in the queued generation", async () => {
    const { controller, client, keys } = setup();
    await controller.select("run:one");
    client.generate.mockRejectedValueOnce(new Error("response lost"));
    await controller.generate();
    expect(controller.state).toMatchObject({ uncertain: true, pendingKind: "generate" });
    await controller.approve();
    expect(client.approve).not.toHaveBeenCalled();
    const { draft, ...base } = { ...RECORD, draft: DRAFT };
    expect(draft).toEqual(DRAFT);
    client.generate.mockResolvedValueOnce(
      evaluationResponse(
        TeacherEvaluationSchema.parse({
          ...base,
          evaluationId: "evaluation:two",
          generation: 2,
          state: "queued",
        }),
      ),
    );
    await controller.generate();
    expect(client.generate.mock.calls[0]).toEqual(client.generate.mock.calls[1]);
    expect(client.generate.mock.calls[0]?.slice(0, 3)).toEqual([
      "run:one",
      "evaluation:one",
      "action:one",
    ]);
    expect(keys).toHaveBeenCalledOnce();
    expect(controller.state).toMatchObject({
      uncertain: false,
      draft: null,
      evaluation: { state: "queued" },
    });
    await controller.generate();
    expect(client.generate).toHaveBeenCalledTimes(2);
    client.query.mockResolvedValueOnce(
      evaluationResponse(TeacherEvaluationSchema.parse({ ...base, state: "running" })),
    );
    await controller.refresh();
    await controller.generate();
    expect(client.generate).toHaveBeenCalledTimes(2);
  });

  it("supports first generation and handles invalid edits or failed reads without writing", async () => {
    const { controller, client } = setup();
    client.query.mockResolvedValueOnce(evaluationResponse(null));
    await controller.select("run:one");
    controller.edit(DRAFT);
    expect(controller.state.error).toBe(false);
    expect(controller.state.draft).toBeNull();
    await controller.approve();
    expect(client.approve).not.toHaveBeenCalled();
    await controller.generate();
    expect(client.generate).toHaveBeenLastCalledWith(
      "run:one",
      null,
      "action:one",
      expect.any(AbortSignal),
    );
    controller.edit({ ...DRAFT, studentFeedback: " " });
    await controller.approve();
    expect(controller.state.error).toBe(true);
    expect(controller.state.uncertain).toBe(false);
    expect(client.approve).not.toHaveBeenCalled();
    client.query.mockRejectedValueOnce(new Error("private error"));
    await controller.refresh();
    expect(controller.state).toMatchObject({
      busy: false,
      error: true,
      draft: null,
      history: null,
      evaluation: null,
      uncertain: false,
    });
    await controller.nextHistory();
    expect(controller.state.error).toBe(true);
  });

  it("serializes actions and prevents stale updates after disposal", async () => {
    const { controller, client, changed } = setup();
    await controller.select("run:one");
    let complete: ((response: typeof SESSIONS) => void) | undefined;
    client.sessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const loading = controller.loadSessions();
    expect(controller.state.busy).toBe(true);
    await controller.select("run:other");
    controller.edit({ ...DRAFT, teacherNote: "Must not change during a pending read" });
    expect(client.query).toHaveBeenCalledOnce();
    expect(controller.state.draft).toEqual(DRAFT);
    controller.dispose();
    expect(client.sessions.mock.calls[0]?.[1].aborted).toBe(true);
    const updates = changed.mock.calls.length;
    complete?.(SESSIONS);
    await loading;
    await controller.loadSessions();
    expect(changed).toHaveBeenCalledTimes(updates);
    expect(client.sessions).toHaveBeenCalledOnce();
  });

  it("never approves an incomplete review state", async () => {
    const { controller, client } = setup();
    for (const partial of [
      { runId: null, draft: DRAFT },
      { runId: "run:one", draft: null },
    ]) {
      controller.state = { ...controller.state, ...partial, evaluation: RECORD };
      await controller.approve();
      expect(controller.state.error).toBe(false);
    }
    expect(client.approve).not.toHaveBeenCalled();
  });

  it("does not advance history without a selected run", async () => {
    const { controller, client } = setup();
    controller.state = { ...controller.state, history: HISTORY };
    await controller.nextHistory();
    expect(client.history).not.toHaveBeenCalled();
  });
});
