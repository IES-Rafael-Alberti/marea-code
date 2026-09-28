import { expect, it, vi } from "vitest";
import { createOperationalTelemetry } from "@marea/telemetry-pipeline";
import { observeServerOperation } from "./operation.js";

it.each([true, false])(
  "emits only duration and outcome while retaining operation result %s",
  async (ok) => {
    const runtime = createOperationalTelemetry();
    const emit = vi.fn(runtime.emit);
    const result = { ok, private: "synthetic-secret" };
    await expect(
      observeServerOperation(
        { ...runtime, emit },
        () => Promise.resolve(result),
        (value) => value.ok,
      ),
    ).resolves.toBe(result);
    const event = emit.mock.calls[0]?.[0];
    expect(event?.attributes).toEqual([
      {
        key: "operation.duration-ms",
        classification: "operational",
        value: expect.any(Number) as unknown,
      },
      { key: "operation.succeeded", classification: "operational", value: ok },
    ]);
    expect(JSON.stringify(event)).not.toContain("secret");
  },
);
it("preserves the exact thrown operation error even when optional telemetry throws", async () => {
  const error = new Error("synthetic-private-error");
  const emit = vi.fn<ReturnType<typeof createOperationalTelemetry>["emit"]>(() =>
    Promise.reject(new Error("synthetic-secret")),
  );
  await expect(
    observeServerOperation(
      { ...createOperationalTelemetry(), emit },
      () => Promise.reject(error),
      () => true,
    ),
  ).rejects.toBe(error);
  expect(emit.mock.calls).toHaveLength(1);
  expect(emit.mock.calls[0]?.[0].attributes).toContainEqual({
    key: "operation.succeeded",
    classification: "operational",
    value: false,
  });
});
it("measures elapsed monotonic time and supplies fixed operational labels", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(125);
  const runtime = createOperationalTelemetry();
  const emit = vi.fn(runtime.emit);
  try {
    await observeServerOperation(
      { ...runtime, emit },
      () => Promise.resolve("synthetic"),
      () => true,
    );
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      id: "server-operation",
      name: "server-operation",
      kind: "metric",
      attributes: [
        { key: "operation.duration-ms", classification: "operational", value: 25 },
        { key: "operation.succeeded", classification: "operational", value: true },
      ],
    });
  } finally {
    now.mockRestore();
  }
});
