import { expect, it, vi } from "vitest";
import {
  PublishTeacherNoticeResponseSchema,
  TeacherNoticeQueryResponseSchema,
} from "@marea/protocol";
import { NoticeController } from "./notice-controller.js";
import type { NoticeClient } from "./notice-client.boundary.js";
const published = PublishTeacherNoticeResponseSchema.parse({
  kind: "teacher-notice-published",
  protocolVersion: "0.1",
  requestId: "request:one",
  notice: {
    noticeId: "event:notice",
    runId: "run:one",
    source: "teacher-message",
    teacherDisplayName: "Teacher",
    text: "Message",
    createdAt: "2026-09-19T08:00:00.000Z",
  },
});
function setup() {
  const client = {
    publish: vi.fn<NoticeClient["publish"]>().mockResolvedValue(published),
    query: vi.fn<NoticeClient["query"]>(),
  };
  const changed = vi.fn();
  const key = vi.fn(() => "notice:one");
  const controller = new NoticeController("run:one", client, changed, key);
  return { client, changed, key, controller };
}
function status(received: boolean) {
  return TeacherNoticeQueryResponseSchema.parse({
    kind: "teacher-notice-status",
    protocolVersion: "0.1",
    requestId: "request:lookup",
    runId: "run:one",
    idempotencyKey: "notice:one",
    publication: {
      notice: published.notice,
      acknowledgedAt: received ? "2026-09-19T08:01:00.000Z" : null,
    },
  });
}
it("keeps publication separate from receipt and permits a new message only after certainty", async () => {
  const { controller, client } = setup();
  expect(controller.state).toEqual({
    draft: "",
    busy: false,
    uncertain: false,
    error: false,
    publication: null,
  });
  await controller.refresh();
  expect(controller.state.error).toBe(false);
  expect(client.query).not.toHaveBeenCalled();
  await controller.send();
  expect(controller.state.error).toBe(true);
  expect(client.publish).not.toHaveBeenCalled();
  controller.edit(" Message ");
  await controller.send();
  expect(client.publish).toHaveBeenCalledExactlyOnceWith(
    "run:one",
    "Message",
    "notice:one",
    expect.any(AbortSignal),
  );
  expect(controller.state).toMatchObject({
    draft: "",
    uncertain: false,
    publication: { acknowledgedAt: null },
  });
  await controller.send();
  expect(client.publish).toHaveBeenCalledOnce();
  client.query.mockResolvedValue(status(true));
  await controller.refresh();
  expect(controller.state.publication?.acknowledgedAt).toBe("2026-09-19T08:01:00.000Z");
  controller.newMessage();
  expect(controller.state).toEqual({
    draft: "",
    busy: false,
    uncertain: false,
    error: false,
    publication: null,
  });
  controller.edit("Next");
  expect(controller.state.draft).toBe("Next");
  controller.dispose();
});
it("never automatically resends an uncertain publication and reuses the exact key/body on explicit retry", async () => {
  const { controller, client, key } = setup();
  controller.edit("Message");
  client.publish.mockRejectedValueOnce(new Error("lost response"));
  await controller.send();
  expect(controller.state).toMatchObject({ error: true, busy: false, uncertain: true });
  controller.edit("Changed");
  controller.newMessage();
  expect(controller.state.draft).toBe("Message");
  client.query.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state.error).toBe(true);
  client.query.mockResolvedValue({ ...status(false), publication: null });
  await controller.refresh();
  expect(controller.state.uncertain).toBe(true);
  expect(client.publish).toHaveBeenCalledOnce();
  await controller.send();
  expect(key).toHaveBeenCalledOnce();
  expect(client.publish.mock.calls[0]?.slice(0, 3)).toEqual(
    client.publish.mock.calls[1]?.slice(0, 3),
  );
  controller.dispose();
});
it("recovers a lost publication by readback without sending again", async () => {
  const { controller, client } = setup();
  controller.edit("Message");
  client.publish.mockRejectedValueOnce(new Error("lost"));
  await controller.send();
  client.query.mockResolvedValue(status(false));
  await controller.refresh();
  expect(controller.state.uncertain).toBe(false);
  expect(controller.state.draft).toBe("");
  expect(client.publish).toHaveBeenCalledOnce();
  controller.dispose();
});
it("ignores a late mutation after disposal and prevents overlapping actions", async () => {
  const { controller, client, changed } = setup();
  const result = Promise.withResolvers<typeof published>();
  client.publish.mockReturnValue(result.promise);
  controller.edit("Message");
  const first = controller.send();
  await controller.send();
  await controller.refresh();
  expect(client.query).not.toHaveBeenCalled();
  expect(controller.state.busy).toBe(true);
  controller.edit("other");
  controller.newMessage();
  expect(controller.state.draft).toBe("Message");
  expect(client.publish).toHaveBeenCalledOnce();
  controller.dispose();
  expect(client.publish.mock.calls[0]?.[3].aborted).toBe(true);
  changed.mockClear();
  result.resolve(published);
  await first;
  await controller.send();
  await controller.refresh();
  expect(changed).not.toHaveBeenCalled();
});
it("generates a fresh idempotency key for each confirmed new message", async () => {
  const { client } = setup();
  const controller = new NoticeController("run:one", client, vi.fn());
  controller.edit("First");
  await controller.send();
  controller.newMessage();
  controller.edit("Second");
  await controller.send();
  const keys = client.publish.mock.calls.map((call) => call[2]);
  expect(keys[0]).toMatch(/^notice:[a-f0-9-]{36}$/u);
  expect(keys[1]).not.toBe(keys[0]);
  controller.dispose();
});

it("serializes readback, preserves its error, and stops querying after disposal", async () => {
  const { controller, client } = setup();
  controller.edit("Message");
  await controller.send();
  client.query.mockRejectedValueOnce(new Error("offline"));
  await controller.refresh();
  expect(controller.state).toMatchObject({ busy: false, error: true });
  const reply = Promise.withResolvers<ReturnType<typeof status>>();
  client.query.mockReturnValueOnce(reply.promise);
  const reading = controller.refresh();
  expect(controller.state.busy).toBe(true);
  await controller.refresh();
  expect(client.query).toHaveBeenCalledTimes(2);
  reply.resolve(status(true));
  await reading;
  expect(controller.state).toMatchObject({ busy: false, error: false });
  controller.dispose();
  await controller.refresh();
  expect(client.query).toHaveBeenCalledTimes(2);
  expect(client.query.mock.calls[1]?.[2].aborted).toBe(true);
});

it("notifies draft updates, clears earlier validation errors, and never resends a published notice", async () => {
  const { controller, client, changed } = setup();
  await controller.send();
  expect(controller.state.error).toBe(true);
  controller.edit("Message");
  expect(changed).toHaveBeenCalled();
  await controller.send();
  expect(controller.state.error).toBe(false);
  controller.edit("Another draft");
  await controller.send();
  expect(client.publish).toHaveBeenCalledOnce();
  controller.dispose();
});
