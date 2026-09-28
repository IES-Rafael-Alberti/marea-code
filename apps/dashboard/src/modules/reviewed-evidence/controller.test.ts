import { expect, it, vi } from "vitest";
import type { ReviewedEvidencePort, ReviewedEvidenceResponse } from "@marea/protocol";
import { ReviewedEvidenceController } from "./controller.js";
import { criterion, page, query } from "./evidence.fixture.js";
import { UsageHealthRequestError } from "../usage-health-client.boundary.js";

function fixture() {
  const read = vi.fn<ReviewedEvidencePort["read"]>((input) =>
    Promise.resolve(page({ kind: input.kind, query: input, entries: [], next: null })),
  );
  const changed = vi.fn();
  return { read, changed, controller: new ReviewedEvidenceController({ read }, changed) };
}
it("reads only with a class, drills down and refreshes from the first page", async () => {
  const f = fixture();
  expect(f.controller.status).toBe("empty");
  expect(f.controller.navigationBlocked).toBe(false);
  expect(f.controller.response).toBeNull();
  await f.controller.refresh();
  await f.controller.more();
  await f.controller.start(null);
  await f.controller.criteria("s1");
  await f.controller.history("s1", criterion);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.controller.status).toBe("empty");
  await f.controller.start("class:one");
  expect(f.read.mock.lastCall?.[0]).toMatchObject({
    kind: "students",
    classId: "class:one",
    limit: 25,
    protocolVersion: "0.1",
    requestId: expect.stringMatching(/^evidence:[\da-f-]{36}$/) as string,
  });
  expect(f.controller.status).toBe("ready");
  await f.controller.criteria("s1");
  expect(f.read.mock.lastCall?.[0]).toMatchObject({ kind: "criteria", studentId: "s1" });
  await f.controller.history("s1", criterion);
  expect(f.read.mock.lastCall?.[0]).toMatchObject({ kind: "history", studentId: "s1", criterion });
  await f.controller.refresh();
  expect(f.read.mock.lastCall?.[0]).toHaveProperty("after", undefined);
  expect(f.read.mock.lastCall?.[0]).toMatchObject({ kind: "history", studentId: "s1", criterion });
  await f.controller.students();
  expect(f.read.mock.lastCall?.[0]).toMatchObject({ kind: "students", classId: "class:one" });
  const calls = f.read.mock.calls.length;
  await f.controller.more();
  expect(f.read).toHaveBeenCalledTimes(calls);
});

it("refreshes an unselected context visibly and clears navigation errors when the class is cleared", async () => {
  const f = fixture();
  await f.controller.refresh();
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  await f.controller.start("class:one");
  await f.controller.open("run:1", () => Promise.resolve(false));
  expect(f.controller.navigationBlocked).toBe(true);
  await f.controller.start(null);
  expect(f.controller.navigationBlocked).toBe(false);
  expect(f.controller.status).toBe("empty");
  expect(f.controller.response).toBeNull();
});

it("notifies the UI of empty, loading, ready, failed and blocked transitions and aborts a disposed read", async () => {
  const transitions: string[] = [];
  const pending = Promise.withResolvers<ReviewedEvidenceResponse>();
  const read = vi.fn<ReviewedEvidencePort["read"]>().mockReturnValueOnce(pending.promise);
  const controller = new ReviewedEvidenceController({ read }, () => {
    transitions.push(controller.status);
  });
  const loading = controller.start("class:one");
  expect(transitions).toEqual(["empty", "loading"]);
  pending.resolve(page());
  await loading;
  expect(transitions).toEqual(["empty", "loading", "ready"]);
  await controller.open("run:1", () => Promise.resolve(false));
  expect(transitions).toEqual(["empty", "loading", "ready", "ready"]);
  const late = Promise.withResolvers<ReviewedEvidenceResponse>();
  read.mockReturnValueOnce(late.promise);
  const refresh = controller.refresh();
  controller.dispose();
  expect(read.mock.lastCall?.[1].aborted).toBe(true);
  late.resolve(page());
  await refresh;
  expect(transitions).toEqual(["empty", "loading", "ready", "ready", "loading"]);
});
it.each([
  [query(), "s1"],
  [query({ kind: "criteria", studentId: "s1" }), criterion],
  [
    query({ kind: "history", studentId: "s1", criterion }),
    { approvedAt: "2026-09-07T12:00:00.000Z", evaluationId: "evaluation:1" },
  ],
] as const)("uses the server cursor for %s and discards it on refresh", async (input, next) => {
  const f = fixture();
  await f.controller.start("class:one");
  f.controller.response = page({ kind: input.kind, query: input, entries: [], next });
  await f.controller.more();
  expect(f.read.mock.lastCall?.[0]).toMatchObject({
    ...input,
    requestId: expect.any(String) as string,
    after: next,
  });
  await f.controller.refresh();
  expect(f.read.mock.lastCall?.[0]).toHaveProperty("after", undefined);
});
it.each([
  [401, "denied"],
  [403, "denied"],
  [503, "error"],
  [500, "error"],
] as const)("sanitizes HTTP %i", async (code, status) => {
  const f = fixture();
  f.read.mockRejectedValue(new UsageHealthRequestError(code));
  await f.controller.start("class:one");
  expect(f.controller.status).toBe(status);
  expect(f.controller.response).toBeNull();
});
it("cancels class replacements, resets empty selection and ignores late success or failure", async () => {
  const f = fixture();
  const late = Promise.withResolvers<ReviewedEvidenceResponse>();
  f.read.mockReturnValueOnce(late.promise);
  const first = f.controller.start("class:one");
  expect(f.controller.status).toBe("loading");
  await f.controller.start("class:two");
  expect(f.read.mock.calls[0]?.[1].aborted).toBe(true);
  late.resolve(page());
  await first;
  expect(f.controller.response?.query.classId).toBe("class:two");
  const pending = Promise.withResolvers<ReviewedEvidenceResponse>();
  f.read.mockReturnValueOnce(pending.promise);
  const second = f.controller.refresh();
  await f.controller.start(null);
  pending.reject(new Error("private"));
  await second;
  expect(f.controller.response).toBeNull();
  expect(f.controller.status).toBe("empty");
  f.controller.dispose();
  await f.controller.start("class:one");
  expect(f.read).toHaveBeenCalledTimes(3);
});
it("reports blocked navigation without leaking errors and ignores navigation after disposal or context change", async () => {
  const f = fixture();
  await f.controller.start("class:one");
  const navigate = vi.fn().mockResolvedValue(false);
  await f.controller.open("run:1", navigate);
  expect(navigate).toHaveBeenCalledWith("run:1");
  expect(f.controller.navigationBlocked).toBe(true);
  await f.controller.open("run:1", () => Promise.resolve(true));
  expect(f.controller.navigationBlocked).toBe(false);
  await f.controller.open("run:1", () => Promise.reject(new Error("private")));
  expect(f.controller.navigationBlocked).toBe(true);
  const late = Promise.withResolvers<boolean>();
  const opening = f.controller.open("run:1", () => late.promise);
  await f.controller.start("class:two");
  late.resolve(false);
  await opening;
  expect(f.controller.navigationBlocked).toBe(false);
  const disposed = Promise.withResolvers<boolean>();
  const last = f.controller.open("run:1", () => disposed.promise);
  f.controller.dispose();
  disposed.resolve(false);
  await last;
  await f.controller.open("run:1", navigate);
  expect(navigate).toHaveBeenCalledOnce();
});
