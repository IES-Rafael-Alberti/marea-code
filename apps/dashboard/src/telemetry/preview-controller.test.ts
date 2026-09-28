import { expect, it, vi } from "vitest";
import { PreviewController } from "./preview-controller.js";
import { PreviewRequestError } from "./preview-client.boundary.js";
import { sample } from "./preview.fixture.js";
it("starts empty, loads only a class-bound synthetic request and clears on disposal", async () => {
  const preview = vi.fn().mockResolvedValue(sample);
  const changed = vi.fn();
  const c = new PreviewController({ preview }, changed);
  expect(c.state).toEqual({ status: "empty" });
  c.dispose();
  const work = c.load("class:a");
  expect(c.state).toEqual({ status: "loading" });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(preview.mock.calls[0]?.[0]).toEqual({
    protocolVersion: "0.1",
    kind: "telemetry-preview",
    classId: "class:a",
    requestId: expect.stringMatching(/^preview:[\da-f-]{36}$/) as string,
  });
  const signal = preview.mock.calls[0]?.[1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  await work;
  expect(c.state).toEqual({ status: "ready", response: sample });
  expect(changed).toHaveBeenCalledTimes(2);
  c.dispose();
  expect(signal.aborted).toBe(true);
  expect(c.state).toEqual({ status: "empty" });
});
it.each([401, 403, 500, "network"])("maps %s to a localized safe state", async (status) => {
  const c = new PreviewController(
    {
      preview: vi
        .fn()
        .mockRejectedValue(
          typeof status === "number" ? new PreviewRequestError(status) : new Error("secret"),
        ),
    },
    vi.fn(),
  );
  await c.load("class:a");
  expect(c.state).toEqual({ status: status === 401 || status === 403 ? "denied" : "error" });
});
it.each([true, false])(
  "ignores late success/error after class replacement (%s)",
  async (success) => {
    const old = Promise.withResolvers<typeof sample>();
    const preview = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(sample);
    const changed = vi.fn();
    const c = new PreviewController({ preview }, changed);
    const first = c.load("class:a");
    await c.load("class:b");
    expect((preview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    if (success) old.resolve({ ...sample, enabled: true });
    else old.reject(new PreviewRequestError(403));
    await first;
    expect(c.state).toEqual({ status: "ready", response: sample });
    expect(changed).toHaveBeenCalledTimes(3);
  },
);
it.each([true, false])("ignores late success/error after logout (%s)", async (success) => {
  const pending = Promise.withResolvers<typeof sample>();
  const changed = vi.fn();
  const c = new PreviewController({ preview: () => pending.promise }, changed);
  const work = c.load("class:a");
  c.dispose();
  if (success) pending.resolve(sample);
  else pending.reject(new Error("late"));
  await work;
  expect(c.state).toEqual({ status: "empty" });
  expect(changed).toHaveBeenCalledTimes(1);
});
