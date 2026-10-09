import { expect, it, vi } from "vitest";
import { abortScope } from "./abort-scope.js";

it.each([0, 1])("propagates cancellation from source %s and detaches every listener", (index) => {
  const sources = [new AbortController(), new AbortController()];
  const listeners = sources.map(({ signal }) => ({
    add: vi.spyOn(signal, "addEventListener"),
    remove: vi.spyOn(signal, "removeEventListener"),
  }));
  const scope = abortScope(sources.map(({ signal }) => signal));
  expect(scope.signal.aborted).toBe(false);
  const reason = new Error("cancelled by source");
  sources[index]?.abort(reason);
  expect(scope.signal.aborted).toBe(true);
  expect(scope.signal.reason).toBe(reason);
  for (const { add, remove } of listeners) {
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]?.[1]);
  }
  scope.dispose();
  for (const { remove } of listeners) expect(remove).toHaveBeenCalledOnce();
});

it("keeps the first already-aborted reason and never subscribes after it", () => {
  const before = new AbortController();
  const after = new AbortController();
  const remove = vi.spyOn(before.signal, "removeEventListener");
  const add = vi.spyOn(after.signal, "addEventListener");
  const scope = abortScope([
    before.signal,
    AbortSignal.abort("first"),
    after.signal,
    AbortSignal.abort("second"),
  ]);
  expect(scope.signal.reason).toBe("first");
  expect(remove).toHaveBeenCalledOnce();
  expect(add).not.toHaveBeenCalled();
});

it("releases completed work without cancelling it or leaving listeners behind", () => {
  const source = new AbortController();
  const remove = vi.spyOn(source.signal, "removeEventListener");
  const scope = abortScope([source.signal]);
  scope.dispose();
  scope.dispose();
  expect(remove).toHaveBeenCalledOnce();
  source.abort();
  expect(scope.signal.aborted).toBe(false);
});
