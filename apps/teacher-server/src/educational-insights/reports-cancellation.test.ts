import { expect, it, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import { input, query, save, observedDraft, pendingReportModel } from "./reports.fixture.js";
import { teacher, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";

it.each(["failed", "interrupted"])(
  "retries %s reports but refuses a second queued job",
  (state) => {
    const f = fixture();
    const first = f.service.reports.generate(teacher, query(f));
    f.database.execute("UPDATE marea_class_reports SET state = ?2 WHERE id = ?1", [
      first.id,
      state,
    ]);
    const retried = f.service.reports.retry(teacher, first.id, "class:one");
    expect(retried.state).toBe("queued");
    expect(input(f, retried.id)).toEqual(input(f, first.id));
    expect(() => f.service.reports.retry(teacher, first.id, "class:one")).toThrow(
      "request.conflict",
    );
  },
);

it("checks report ownership before cancellation and uses its own durable budget", () => {
  const f = fixture();
  const usage = vi.spyOn(f.service.inference, "usage");
  const report = f.service.reports.generate(teacher, query(f));
  expect(usage).toHaveBeenCalledWith(`report:${report.id}`, f.service.configuration.reports);
  expect(() => {
    f.service.reports.cancel(report.id, "class:two");
  }).toThrow("request.conflict");
  expect(f.service.reports.read(report.id, "class:one").state).toBe("queued");
});

it("never starts work for a revoked owner", async () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  const execute = vi.spyOn(f.database, "execute");
  await f.service.reports.tick();
  expect(
    execute.mock.calls.some(
      ([sql]) => sql === "UPDATE marea_class_reports SET state = 'running' WHERE id = ?1",
    ),
  ).toBe(false);
  expect(f.service.reports.read(report.id, "class:one").state).toBe("failed");
});

it.each(["cancel", "revoke", "invalidate"] as const)(
  "rechecks %s after the last evaluation and never starts synthesis",
  async (operation) => {
    const f = fixture();
    const report = f.service.reports.generate(teacher, query(f));
    const frozen = input(f, report.id);
    const source = frozen.sources[0];
    if (source === undefined) throw new Error("source");
    save(f, report.id, { ...frozen, sources: [source] });
    const draft = observedDraft(source);
    const pending = Promise.withResolvers<object>();
    const generate = vi
      .spyOn(f.service.inference, "generate")
      .mockImplementation((_r, _a, _s, _m, schema) =>
        pending.promise.then((value) => schema.parse(value)),
      );
    const require = vi.spyOn(f.service.progress, "require");
    const tick = f.service.reports.tick();
    expect(require).toHaveBeenCalled();
    expect(
      require.mock.calls.every(
        ([identity, classId]) =>
          identity.userId === teacher.userId &&
          identity.role === "teacher" &&
          identity.classId === null &&
          identity.displayName === "" &&
          classId === "class:one",
      ),
    ).toBe(true);
    if (operation === "cancel") f.service.reports.cancel(report.id, "class:one");
    else if (operation === "revoke")
      f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    else
      f.database.execute("UPDATE marea_class_reports SET state = 'invalidated' WHERE id = ?1", [
        report.id,
      ]);
    pending.resolve(draft);
    await tick;
    expect(generate).toHaveBeenCalledOnce();
    expect(f.service.reports.read(report.id, "class:one").state).toBe(
      operation === "cancel" ? "cancelled" : operation === "revoke" ? "failed" : "invalidated",
    );
  },
);

it("preserves interrupted synthesis for restart recovery instead of marking it failed", async () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  save(f, report.id, {
    ...frozen,
    sources: frozen.sources.map((s) => ({ ...s, approved: EVALUATION_DRAFT })),
  });
  const { pending, generate, tick } = await pendingReportModel(f);
  f.service.reports.stop();
  expect(generate.mock.calls[0]?.[5].aborted).toBe(true);
  pending.reject(new Error("stopped"));
  await tick;
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "running",
    error: null,
    result: null,
  });
});
