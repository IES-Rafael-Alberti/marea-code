import { expect, it, vi } from "vitest";
import { openEvidenceSession } from "./navigation.js";
const session = () => ({
  state: { classId: "class:one", connection: "current" as "current" | "stale" },
  hasUnsavedDrafts: false,
  select: vi.fn().mockResolvedValue(undefined),
});
it("opens only a mounted class-matching session and honors the existing draft decision", async () => {
  const f = session(),
    confirm = vi.fn().mockReturnValue(false),
    signal = new AbortController().signal;
  expect(await openEvidenceSession(null, "class:one", "run:1", signal, confirm)).toBe(false);
  expect(await openEvidenceSession(f, null, "run:1", signal, confirm)).toBe(false);
  expect(
    await openEvidenceSession(
      { ...f, state: { ...f.state, classId: null } },
      null,
      "run:1",
      signal,
      confirm,
    ),
  ).toBe(false);
  expect(await openEvidenceSession(f, "class:two", "run:1", signal, confirm)).toBe(false);
  expect(await openEvidenceSession(f, "class:one", "run:1", AbortSignal.abort(), confirm)).toBe(
    false,
  );
  expect(f.select).not.toHaveBeenCalled();
  expect(await openEvidenceSession(f, "class:one", "run:1", signal, confirm)).toBe(true);
  expect(f.select).toHaveBeenCalledExactlyOnceWith("run:1");
  expect(confirm).not.toHaveBeenCalled();
  f.hasUnsavedDrafts = true;
  expect(await openEvidenceSession(f, "class:one", "run:2", signal, confirm)).toBe(false);
  expect(f.select).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  expect(await openEvidenceSession(f, "class:one", "run:2", signal, confirm)).toBe(true);
  expect(f.select).toHaveBeenLastCalledWith("run:2");
  expect(confirm).toHaveBeenCalledTimes(2);
});
it("does not report success after cancellation, context replacement or a failed history read", async () => {
  const f = session(),
    abort = new AbortController();
  f.select.mockImplementationOnce(() => {
    abort.abort();
    return Promise.resolve();
  });
  expect(await openEvidenceSession(f, "class:one", "run:1", abort.signal, () => true)).toBe(false);
  f.select.mockImplementationOnce(() => {
    f.state.classId = "class:two";
    return Promise.resolve();
  });
  expect(
    await openEvidenceSession(f, "class:one", "run:1", new AbortController().signal, () => true),
  ).toBe(false);
  f.state.connection = "stale";
  expect(
    await openEvidenceSession(f, "class:two", "run:1", new AbortController().signal, () => true),
  ).toBe(false);
});
