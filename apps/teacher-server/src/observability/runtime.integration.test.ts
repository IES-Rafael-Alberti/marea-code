import { afterEach, expect, it, vi } from "vitest";
import { TelemetryExporterError } from "@marea/plugin-api";
import { completeTurn, observabilityFixture } from "./observability.fixture.js";
import { NOW } from "../../test-support/history-fixture.js";
import { ObservabilityRuntime } from "./runtime.js";
import * as delivery from "./delivery.js";

afterEach(() => {
  vi.useRealTimers();
});
it("does not acknowledge a completed request after its delivery generation was replaced", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    completeTurn(f.database);
    vi.spyOn(delivery, "deliverTrace").mockImplementationOnce(() => {
      f.runtime.changed();
      return Promise.resolve();
    });
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ pending: 1, sent: 0, failed: 0 });
    vi.restoreAllMocks();
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ pending: 0, sent: 1 });
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
it("captures only future completed turns and retries stable IDs across runtime replacement", async () => {
  const f = observabilityFixture();
  try {
    completeTurn(f.database);
    await f.save();
    await f.runtime.tick();
    expect(f.traces).toEqual([]);
    completeTurn(f.database, 8);
    f.fail(new Error("private provider failure"));
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({
      pending: 1,
      failed: 0,
      sent: 0,
      healthy: true,
      available: true,
    });
    expect(
      f.database.readOne("SELECT attempts,last_error,next_at FROM marea_trace_outbox"),
    ).toEqual({ attempts: 1n, last_error: "unavailable", next_at: "2026-09-07T12:00:02.000Z" });
    await f.runtime.tick();
    expect(f.traces).toHaveLength(0);
    f.fail();
    const restarted = new ObservabilityRuntime(
      f.database,
      f.store,
      f.catalog,
      { now: () => "2026-09-07T12:00:03.000Z" },
      "release",
      () => [],
    );
    await restarted.tick();
    expect(restarted.status()).toMatchObject({
      pending: 0,
      sent: 1,
      lastSentAt: "2026-09-07T12:00:03.000Z",
    });
    expect(f.traces[0]).toMatchObject({
      version: 1,
      release: "release",
      spans: [
        { type: "agent", input: "Write a Python greeting", output: "Use print('hello')" },
        { type: "generation", model: "synthetic-model" },
      ],
    });
    await restarted.tick();
    expect(f.traces).toHaveLength(1);
  } finally {
    f.database.close();
  }
});
it("pauses when a plugin is removed and disabling clears pending references", async () => {
  const f = observabilityFixture();
  try {
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ available: false, pending: 0 });
    await f.save();
    completeTurn(f.database);
    f.fail(new TelemetryExporterError("payload-too-large"));
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ pending: 0, failed: 1 });
    f.catalog.length = 0;
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ failed: 1, available: false });
    await f.save({ enabled: false, values: {} });
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ failed: 0, pending: 0 });
    expect(f.traces).toEqual([]);
  } finally {
    f.database.close();
  }
});
it("recovers queue faults without stopping sessions and owns background timers", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    const capture = vi.spyOn(f.runtime.queue, "capture").mockImplementationOnce(() => {
      throw new Error("database busy");
    });
    await f.runtime.tick();
    expect(f.runtime.status().healthy).toBe(false);
    await f.runtime.tick();
    expect(f.runtime.status().healthy).toBe(true);
    vi.useFakeTimers();
    f.runtime.start();
    f.runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(3);
    await f.runtime.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(f.runtime.queue.status().lastSentAt).toBeNull();
    f.runtime.queue.retry(NOW);
  } finally {
    f.database.close();
  }
});

it("cancels in-flight delivery on disable and restarts without acknowledging abandoned work", async () => {
  const f = observabilityFixture();
  try {
    f.runtime.changed();
    await f.save();
    completeTurn(f.database);
    const pending = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    if (!f.entry.traces) throw new Error("fixture");
    vi.spyOn(f.entry.traces, "create").mockReturnValue({
      export: () => {
        started.resolve(undefined);
        return pending.promise;
      },
    });
    const task = f.runtime.tick();
    await started.promise;
    await f.save({ enabled: false, values: {} });
    await task;
    expect(f.runtime.status()).toMatchObject({ pending: 0, sent: 0, failed: 0 });
    pending.resolve(undefined);
    vi.restoreAllMocks();
    await f.save();
    completeTurn(f.database, 8);
    vi.useFakeTimers();
    f.runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    await f.runtime.stop();
    expect(f.runtime.status().sent).toBe(1);
    f.runtime.start();
    await vi.advanceTimersByTimeAsync(1000);
    await f.runtime.stop();
    expect(f.runtime.status().sent).toBe(1);
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
it("discards orphaned references and stops scheduling when shut down during a batch", async () => {
  const f = observabilityFixture();
  try {
    await f.save();
    completeTurn(f.database);
    const read = f.database.readOne.bind(f.database);
    vi.spyOn(f.database, "readOne").mockImplementation((sql, args) =>
      sql.startsWith("SELECT runs.student_id") ? undefined : read(sql, args),
    );
    await f.runtime.tick();
    expect(f.runtime.status().pending).toBe(0);
    expect(f.traces).toEqual([]);
    vi.restoreAllMocks();
    completeTurn(f.database, 8);
    if (!f.entry.traces) throw new Error("fixture");
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(f.entry.traces, "create").mockReturnValue({
      export: () => {
        started.resolve(undefined);
        return new Promise(() => undefined);
      },
    });
    vi.useFakeTimers();
    f.runtime.start();
    vi.advanceTimersByTime(1000);
    await started.promise;
    await f.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.database.readOne("SELECT attempts,last_error FROM marea_trace_outbox")).toEqual({
      attempts: 0n,
      last_error: null,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.runtime.status().pending).toBe(1);
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});

it("limits each batch, repeats background ticks and initializes persisted capture boundaries on restart", async () => {
  const f = observabilityFixture();
  try {
    expect(f.runtime.status().healthy).toBe(true);
    await f.save();
    completeTurn(f.database);
    const current = f.store.read();
    const config = current?.observability;
    if (!current || !config) throw new Error("fixture");
    f.store.write(
      { ...current, observability: { ...config, epoch: "persisted-generation" } },
      current.revision,
    );
    await f.runtime.tick();
    expect(f.traces).toEqual([]);
    for (let i = 0; i < 9; i++) completeTurn(f.database, 8 + i * 5);
    await f.runtime.tick();
    expect(f.traces).toHaveLength(8);
    expect(f.runtime.status().pending).toBe(1);
    vi.useFakeTimers();
    const capture = vi.spyOn(f.runtime.queue, "capture");
    f.runtime.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(f.traces).toHaveLength(9);
    await f.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.spyOn(f.store, "read").mockReturnValue(null);
    f.runtime.changed();
    await f.runtime.tick();
    expect(f.runtime.status()).toMatchObject({ healthy: true, available: false });
  } finally {
    vi.restoreAllMocks();
    f.database.close();
  }
});
it("keeps unavailable and disabled destinations healthy without delivering any queued content", async () => {
  const f = observabilityFixture();
  try {
    await f.runtime.tick();
    expect(f.runtime.status().healthy).toBe(true);
    await f.save({ enabled: false });
    completeTurn(f.database);
    await f.runtime.tick();
    expect(f.traces).toEqual([]);
    expect(f.runtime.status().healthy).toBe(true);
    f.catalog.splice(0, 1, { manifest: f.entry.manifest });
    expect(f.runtime.status().available).toBe(false);
    const current = f.store.read();
    const config = current?.observability;
    if (!current || !config) throw new Error("fixture");
    f.store.write({ ...current, observability: { ...config, enabled: true } }, current.revision);
    await f.runtime.tick();
    expect(f.runtime.status().healthy).toBe(true);
    f.catalog.length = 0;
    await f.runtime.tick();
    expect(f.runtime.status().healthy).toBe(true);
  } finally {
    f.database.close();
  }
});

it("delivers only through the selected installed destination when multiple plugins are available", async () => {
  const f = observabilityFixture();
  try {
    const implementation = f.entry.traces;
    if (!implementation) throw new Error("fixture");
    const wrong = vi.fn(() => {
      throw new Error("wrong destination");
    });
    f.catalog.unshift({
      ...f.entry,
      manifest: { ...f.entry.manifest, id: "org.marea.other" },
      traces: { ...implementation, create: wrong },
    });
    await f.save();
    completeTurn(f.database);
    await f.runtime.tick();
    expect(wrong).not.toHaveBeenCalled();
    expect(f.traces).toHaveLength(1);
  } finally {
    f.database.close();
  }
});
