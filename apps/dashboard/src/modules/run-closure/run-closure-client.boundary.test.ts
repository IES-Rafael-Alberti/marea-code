import { describe, expect, it, vi } from "vitest";

import { createRunClosureClient, RunClosureError } from "./run-closure-client.boundary.js";

const signal = new AbortController().signal;

interface Sent {
  readonly requestId: string;
}

const sentBody = (init: RequestInit | undefined) => JSON.parse(init?.body as string) as Sent;

function setup(reply: (body: Sent) => Response) {
  const fetchRequest = vi.fn((_path: string, init: RequestInit) =>
    Promise.resolve(reply(sentBody(init))),
  );
  let id = 0;
  const client = createRunClosureClient(fetchRequest, () => `request:close-${String(++id)}`);
  return { client, fetchRequest };
}

const answer = (body: Sent, closed: string[], unchanged: string[] = []) =>
  Response.json({
    protocolVersion: "0.1",
    requestId: body.requestId,
    kind: "runs-close-response",
    closed,
    unchanged,
  });

describe("teacher run closure client", () => {
  it("ends one run with a cookie POST carrying its idempotency key", async () => {
    const { client, fetchRequest } = setup((body) => answer(body, ["run:one"]));
    const result = await client.closeRun("run:one", "close:1", signal);
    expect(result).toMatchObject({ closed: ["run:one"], unchanged: [] });
    const [path, init] = fetchRequest.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/dashboard/runs/close");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    expect(sentBody(init)).toEqual({
      kind: "teacher-run-close",
      protocolVersion: "0.1",
      requestId: "request:close-1",
      runId: "run:one",
      idempotencyKey: "close:1",
    });
  });

  it("ends exactly the listed runs of a class", async () => {
    const { client, fetchRequest } = setup((body) => answer(body, ["run:one"], ["run:two"]));
    const result = await client.closeClassRuns(
      "class:a",
      ["run:one", "run:two"],
      "close:2",
      signal,
    );
    expect(result).toMatchObject({ closed: ["run:one"], unchanged: ["run:two"] });
    const [path, init] = fetchRequest.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/dashboard/classes/close-runs");
    expect(sentBody(init)).toEqual({
      kind: "class-runs-close",
      protocolVersion: "0.1",
      requestId: "request:close-1",
      classId: "class:a",
      runIds: ["run:one", "run:two"],
      idempotencyKey: "close:2",
    });
  });

  it.each([
    ["a refused request", () => new Response("{}", { status: 403 })],
    ["another request's answer", () => answer({ requestId: "request:other" }, ["run:one"])],
    ["a run that was not requested", (body: Sent) => answer(body, ["run:one", "run:intruder"])],
    ["a missing run", (body: Sent) => answer(body, [])],
    ["a repeated run", (body: Sent) => answer(body, ["run:one"], ["run:one"])],
  ])("rejects %s", async (_name, reply) => {
    const { client } = setup(reply);
    await expect(client.closeRun("run:one", "close:1", signal)).rejects.toBeInstanceOf(
      RunClosureError,
    );
  });

  it("rejects a class answer that reports one run twice and leaves another out", async () => {
    const { client } = setup((body) => answer(body, ["run:one"], ["run:one"]));
    await expect(
      client.closeClassRuns("class:a", ["run:one", "run:two"], "close:1", signal),
    ).rejects.toBeInstanceOf(RunClosureError);
  });

  it("rejects an answer that does not match the protocol", async () => {
    const { client } = setup(() => Response.json({ kind: "something-else" }));
    await expect(
      client.closeClassRuns("class:a", ["run:one"], "close:1", signal),
    ).rejects.toThrow();
  });

  it("does not build a request for an invalid identifier", () => {
    const { client, fetchRequest } = setup((body) => answer(body, []));
    expect(() => client.closeRun("", "close:1", signal)).toThrow();
    expect(() => client.closeClassRuns("class:a", [], "close:1", signal)).toThrow();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("uses a generated request identifier by default", async () => {
    const fetchRequest = vi.fn((_path: string, init: RequestInit) =>
      Promise.resolve(answer(sentBody(init), ["run:one"])),
    );
    await createRunClosureClient(fetchRequest).closeRun("run:one", "close:1", signal);
    expect(sentBody(fetchRequest.mock.calls[0]?.[1]).requestId).toMatch(/^request:[0-9a-f-]{36}$/u);
  });

  it("explains a failure without revealing server detail", () => {
    expect(new RunClosureError().message).toBe(
      "The sessions could not be ended. Refresh to check their current state.",
    );
  });
});
