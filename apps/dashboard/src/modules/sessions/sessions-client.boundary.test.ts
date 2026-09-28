import { expect, it, vi } from "vitest";
import { createSessionsClient } from "./sessions-client.boundary.js";
import { SESSIONS } from "../evaluation/evaluation.fixture.js";
function setup(patch: object = {}, status = 200) {
  const fetchRequest = vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { requestId: string };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ...SESSIONS,
          kind: "class-sessions-response",
          requestId: body.requestId,
          runs: SESSIONS.runs.map((run) => ({ ...run, classId: "class:one" })),
          ...patch,
        }),
        { status },
      ),
    );
  });
  return { client: createSessionsClient(fetchRequest), fetchRequest };
}
it("queries bounded class pages with cookie authentication and correlation", async () => {
  const { client, fetchRequest } = setup();
  const signal = new AbortController().signal;
  expect((await client.classes("run:prior", signal, "class:one")).runs[0]?.classId).toBe(
    "class:one",
  );
  expect(fetchRequest.mock.calls[0]?.[0]).toBe("/api/v1/dashboard/history/classes");
  expect(fetchRequest.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    method: "POST",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  expect(JSON.parse(fetchRequest.mock.calls[0]?.[1].body as string)).toMatchObject({
    limit: 50,
    classId: "class:one",
    beforeRunId: "run:prior",
  });
  await client.classes(null, signal);
  expect(JSON.parse(fetchRequest.mock.calls[1]?.[1].body as string)).not.toHaveProperty(
    "beforeRunId",
  );
  expect(client).toHaveProperty("history", expect.any(Function));
});
it.each([{ requestId: "request:other" }, { nextBeforeRunId: "run:other" }, { runs: [] }])(
  "rejects mismatched responses (%j)",
  async (patch) => {
    await expect(
      setup(patch).client.classes(null, new AbortController().signal, "class:one"),
    ).rejects.toThrow();
  },
);
it("rejects a different class or failed HTTP response and accepts an empty final page", async () => {
  await expect(
    setup().client.classes(null, new AbortController().signal, "class:two"),
  ).rejects.toThrow();
  await expect(
    setup({}, 403).client.classes(null, new AbortController().signal),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await setup({ runs: [], nextBeforeRunId: null }).client.classes(
        null,
        new AbortController().signal,
      )
    ).runs,
  ).toEqual([]);
});
it("rejects mixed classes and an empty page advertising another page with a diagnostic", async () => {
  const signal = new AbortController().signal;
  await expect(
    setup({
      runs: [
        { ...SESSIONS.runs[0], classId: "class:one" },
        { ...SESSIONS.runs[0], runId: "run:two", classId: "class:two" },
      ],
      nextBeforeRunId: null,
    }).client.classes(null, signal, "class:one"),
  ).rejects.toThrow("Class session response mismatch.");
  await expect(
    setup({ runs: [], nextBeforeRunId: "run:other" }).client.classes(null, signal),
  ).rejects.toThrow("Class session response mismatch.");
});
