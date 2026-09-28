import { expect, it, vi } from "vitest";
import { createNoticeClient } from "./notice-client.boundary.js";
const notice = {
  noticeId: "event:one",
  runId: "run:one",
  text: "Hello",
  teacherDisplayName: "Ada",
  source: "teacher-message",
  createdAt: "2026-09-19T08:00:00.000Z",
};
function setup(patch: object = {}, ok = true) {
  const fetchRequest = vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { requestId: string; kind: string };
    const response =
      body.kind === "teacher-notice-publish"
        ? { kind: "teacher-notice-published", notice }
        : {
            kind: "teacher-notice-status",
            runId: "run:one",
            idempotencyKey: "notice:one",
            publication: { notice, acknowledgedAt: null },
          };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ...response,
          protocolVersion: "0.1",
          requestId: body.requestId,
          ...patch,
        }),
        { status: ok ? 200 : 403 },
      ),
    );
  });
  return { fetchRequest, client: createNoticeClient(fetchRequest) };
}
it("uses same-origin JSON boundaries and correlates publication and receipt lookup", async () => {
  const { fetchRequest, client } = setup();
  const signal = new AbortController().signal;
  expect((await client.publish("run:one", " Hello ", "notice:one", signal)).notice.text).toBe(
    "Hello",
  );
  expect(
    (await client.query("run:one", "notice:one", signal)).publication?.acknowledgedAt,
  ).toBeNull();
  expect(fetchRequest.mock.calls.map((call) => call[0])).toEqual([
    "/api/v1/dashboard/notices/publish",
    "/api/v1/dashboard/notices/query",
  ]);
  for (const [, init] of fetchRequest.mock.calls) {
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
  }
});
it.each([
  { requestId: "request:wrong" },
  { notice: { ...notice, runId: "run:other" } },
  { notice: { ...notice, text: "Changed" } },
  { privateSecret: "never" },
])("rejects unrelated or invalid publications (%j)", async (patch) => {
  await expect(
    setup(patch).client.publish("run:one", "Hello", "notice:one", new AbortController().signal),
  ).rejects.toThrow();
});
it.each([
  { runId: "run:other" },
  { idempotencyKey: "notice:other" },
  { publication: { notice: { ...notice, runId: "run:other" }, acknowledgedAt: null } },
])("rejects unrelated notice readback (%j)", async (patch) => {
  await expect(
    setup(patch).client.query("run:one", "notice:one", new AbortController().signal),
  ).rejects.toThrow();
});
it("accepts an absent publication and rejects HTTP errors", async () => {
  expect(
    (
      await setup({ publication: null }).client.query(
        "run:one",
        "notice:one",
        new AbortController().signal,
      )
    ).publication,
  ).toBeNull();
  await expect(
    setup({}, false).client.query("run:one", "notice:one", new AbortController().signal),
  ).rejects.toThrow("Notice request failed");
});
it("reports correlation and publication mismatches distinctly", async () => {
  const signal = new AbortController().signal;
  await expect(
    setup({ requestId: "request:wrong" }).client.query("run:one", "notice:one", signal),
  ).rejects.toThrow("Notice correlation failed.");
  await expect(
    setup({ notice: { ...notice, text: "changed" } }).client.publish(
      "run:one",
      "Hello",
      "notice:one",
      signal,
    ),
  ).rejects.toThrow("Notice publication mismatch.");
  await expect(
    setup({ runId: "run:other" }).client.query("run:one", "notice:one", signal),
  ).rejects.toThrow("Notice lookup mismatch.");
});
