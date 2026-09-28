import { captured } from "../teacher-host/captured.js";
import { afterEach, expect, it, vi } from "vitest";
import { startTelemetryRuntime } from "./runtime-startup.js";
import { runtimeFixture, syntheticOperation } from "./runtime.fixture.js";

afterEach(() => vi.useRealTimers());

it.each([undefined, { enabled: false }, "secret", null])(
  "defaults or rejects configuration without credential lookup: %j",
  async (configuration) => {
    const f = runtimeFixture();
    const result = await startTelemetryRuntime({ ...f, configuration });
    expect(result.runtime.configuration).toEqual({ enabled: false, destinationCount: 0 });
    expect(result.health.state).toBe(configuration === undefined ? "disabled" : "invalid");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.createOtlp).not.toHaveBeenCalled();
  },
);
it("never resolves disabled destinations even when configured", async () => {
  const f = runtimeFixture();
  const result = await startTelemetryRuntime({
    ...f,
    configuration: { ...f.configuration, enabled: false },
  });
  expect(result.health.state).toBe("disabled");
  expect(f.resolve).not.toHaveBeenCalled();
});
it.each([{ destinations: [] }, { destinations: ["otlp", "otlp"] }])(
  "rejects empty or duplicate selection before lookup: %j",
  async ({ destinations }) => {
    const f = runtimeFixture();
    const result = await startTelemetryRuntime({
      ...f,
      configuration: {
        ...f.configuration,
        exporters: destinations.map(() => f.configuration.exporters[0]),
      },
    });
    expect(result.health.state).toBe("invalid");
    expect(f.resolve).not.toHaveBeenCalled();
  },
);
it("uses the strictest timeout, one frozen envelope, safe aliases and pure preview", async () => {
  const f = runtimeFixture();
  captured(f.configuration.exporters[0]).operationTimeoutMs = 5;
  const { runtime, health } = await startTelemetryRuntime(f);
  expect(runtime.configuration).toEqual({ enabled: true, destinationCount: 2 });
  expect(health.state).toBe("configured");
  expect(health.destinations).toEqual({ otlp: "ready", langfuse: "ready" });
  expect(f.resolve.mock.calls.map(([destination]) => destination)).toEqual(["otlp", "langfuse"]);
  expect(f.createOtlp).toHaveBeenCalledWith(
    { ...captured(f.configuration.exporters[0]), operationTimeoutMs: 5 },
    f.connections.otlp,
  );
  runtime.preview(syntheticOperation);
  expect(f.otlp.exported).toHaveLength(0);
  const report = await runtime.emit(syntheticOperation, f.signal);
  expect(report.outcomes.map((outcome) => outcome.exporterId)).toEqual(["otlp", "langfuse"]);
  expect(f.otlp.exported[0]).toBe(f.langfuse.exported[0]);
  expect(Object.isFrozen(f.otlp.exported[0])).toBe(true);
  expect(JSON.stringify(report)).not.toContain("private");
  expect(f.createLangfuse).toHaveBeenCalledWith(
    { ...captured(f.configuration.exporters[1]), operationTimeoutMs: 5 },
    f.connections.langfuse,
  );
  await runtime.close(f.signal);
  await runtime.close(f.signal);
  expect(f.otlp.shutdownSignals).toHaveLength(1);
  expect((await runtime.emit(syntheticOperation, f.signal)).status).toBe("closed");
});
it.each(["absent", "duplicate", "manifest-only"])(
  "isolates %s catalog destinations",
  async (kind) => {
    const f = runtimeFixture();
    const entry = captured(f.catalog[0]);
    const catalog =
      kind === "absent"
        ? [captured(f.catalog[1])]
        : kind === "duplicate"
          ? [...f.catalog, entry]
          : [{ manifest: entry.manifest }, captured(f.catalog[1])];
    const { runtime, health } = await startTelemetryRuntime({ ...f, catalog });
    expect(runtime.configuration).toEqual({ enabled: true, destinationCount: 1 });
    expect(health.destinations.otlp).toBe("unavailable");
    expect(f.resolve.mock.calls.map(([destination]) => destination)).toEqual(["langfuse"]);
    await runtime.close(f.signal);
  },
);
it("isolates secret and factory failures without leaking their values", async () => {
  const f = runtimeFixture();
  f.resolve.mockRejectedValueOnce(new Error("synthetic-secret https://private.invalid"));
  f.createLangfuse.mockImplementation(() => {
    throw new Error("synthetic-secret");
  });
  const result = await startTelemetryRuntime(f);
  expect(result.runtime.configuration).toEqual({ enabled: true, destinationCount: 0 });
  expect(JSON.stringify(result.health)).not.toMatch(/secret|https/);
});
it("bounds startup and ignores late resolution while preserving the available destination", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  const late = Promise.withResolvers<typeof f.connections.otlp>();
  f.resolve.mockImplementationOnce(() => late.promise);
  const pending = startTelemetryRuntime(f);
  await vi.advanceTimersByTimeAsync(20);
  const result = await pending;
  expect(result.runtime.configuration.destinationCount).toBe(1);
  expect(captured(f.resolve.mock.calls[0])[1].aborted).toBe(true);
  late.resolve(f.connections.otlp);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.createOtlp).not.toHaveBeenCalled();
  await result.runtime.close(f.signal);
});
it("cancels startup and cleans partially constructed ports with a fresh shutdown signal", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  const controller = new AbortController();
  f.resolve.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = startTelemetryRuntime({ ...f, signal: controller.signal });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  const result = await pending;
  expect(result.health.state).toBe("cancelled");
  expect(result.health.destinations).toEqual({ otlp: "unavailable", langfuse: "unavailable" });
  expect(result.runtime.configuration.destinationCount).toBe(0);
  expect(f.langfuse.shutdownSignals).toHaveLength(1);
  expect(captured(f.langfuse.shutdownSignals[0]).aborted).toBe(false);
  expect(f.createOtlp).not.toHaveBeenCalled();
});
it("does not lookup on pre-cancelled startup", async () => {
  const f = runtimeFixture();
  const result = await startTelemetryRuntime({ ...f, signal: AbortSignal.abort() });
  expect(result.health.state).toBe("cancelled");
  expect(f.resolve).not.toHaveBeenCalled();
});
it("retains bounded no-queue backpressure and timeout circuit", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  f.createOtlp.mockReturnValue({ ...f.otlp.port, export: () => new Promise(() => undefined) });
  const { runtime } = await startTelemetryRuntime(f);
  const pending = runtime.emit(syntheticOperation, f.signal);
  expect((await runtime.emit(syntheticOperation, f.signal)).status).toBe("busy");
  await vi.advanceTimersByTimeAsync(10);
  expect(captured((await pending).outcomes[0]).status).toBe("timed-out");
  expect((await runtime.emit(syntheticOperation, f.signal)).status).toBe("unavailable");
  await runtime.close(f.signal);
});
it("cleans malformed factory ports within the shutdown deadline", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  const shutdown = vi.fn(() => new Promise<void>(() => undefined));
  f.createOtlp.mockReturnValue({
    id: "synthetic-secret",
    export: undefined,
    shutdown,
  } as unknown as typeof f.otlp.port);
  const pending = startTelemetryRuntime(f);
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result.runtime.configuration.destinationCount).toBe(1);
  expect(result.health.destinations.otlp).toBe("unavailable");
  expect(shutdown).toHaveBeenCalledOnce();
  await result.runtime.close(f.signal);
});
it("reclaims a port if synchronous construction itself cancels startup", async () => {
  const f = runtimeFixture();
  const controller = new AbortController();
  f.createOtlp.mockImplementation(() => {
    controller.abort();
    return f.otlp.port;
  });
  const result = await startTelemetryRuntime({ ...f, signal: controller.signal });
  expect(result.health.state).toBe("cancelled");
  expect(f.otlp.shutdownSignals).toHaveLength(1);
  expect(f.createLangfuse).not.toHaveBeenCalled();
});
it("isolates invalid ports whose cleanup throws", async () => {
  const f = runtimeFixture();
  f.createOtlp.mockReturnValue(null as unknown as typeof f.otlp.port);
  const result = await startTelemetryRuntime(f);
  expect(result.runtime.configuration.destinationCount).toBe(1);
  await result.runtime.close(f.signal);
});

it("does not lookup credentials for an invalid factory", async () => {
  const f = runtimeFixture();
  const entry = captured(f.catalog[0]);
  const result = await startTelemetryRuntime({
    ...f,
    catalog: [
      {
        ...entry,
        implementation: { destination: "otlp", create: undefined },
      } as unknown as typeof entry,
    ],
  });
  expect(result.runtime.configuration).toEqual({ enabled: true, destinationCount: 0 });
  expect(f.resolve).not.toHaveBeenCalled();
});
it("releases the startup timer and parent listener after successful resolution", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  const controller = new AbortController();
  const result = await startTelemetryRuntime({ ...f, signal: controller.signal });
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(30);
  expect(f.resolve.mock.calls.map(([, signal]) => signal.aborted)).toEqual([false, false]);
  await result.runtime.close(f.signal);
});
