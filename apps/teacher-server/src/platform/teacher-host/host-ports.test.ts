import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InferenceProviderError } from "@marea/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bunServe } from "./bun-serve.boundary.js";
import { createFileHostStatus } from "./host-status.boundary.js";
import { RequestDrain } from "./request-drain.js";
import { createRetryScheduler } from "./retry-scheduler.boundary.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function providerError(retryAfterMs?: number) {
  return new InferenceProviderError({
    code: "rate-limited",
    message: "limited",
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

describe("teacher host retry scheduler", () => {
  it("waits for the provider delay or the configured delay, capped by the maximum", async () => {
    vi.useFakeTimers();
    const scheduler = createRetryScheduler({ delayMs: 100, maxDelayMs: 250 });
    for (const [error, delay] of [
      [providerError(), 100],
      [providerError(40), 40],
      [providerError(1_000), 250],
    ] as const) {
      let settled = false;
      const signal = new AbortController().signal;
      const waiting = scheduler.wait(error, signal).then(() => {
        settled = true;
      });
      expect(getEventListeners(signal, "abort")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(settled).toBe(true);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
  });

  it("rejects with the abort reason before or while waiting", async () => {
    vi.useFakeTimers();
    const scheduler = createRetryScheduler({ delayMs: 100, maxDelayMs: 250 });
    const reason = new Error("cancelled");
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(scheduler.wait(providerError(), aborted.signal)).rejects.toBe(reason);
    const later = new AbortController();
    const waiting = scheduler.wait(providerError(), later.signal);
    later.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("teacher host request drain", () => {
  it("admits while serving, drains in-flight requests and resumes", async () => {
    vi.useFakeTimers();
    const drain = new RequestDrain(() => Date.parse("2026-09-14T10:00:00.000Z"));
    expect(await drain.drain({ drainUntil: "2026-09-14T10:00:01.000Z" })).toBe("drained");
    expect(drain.admit(() => Promise.resolve(1))).toBeUndefined();
    drain.resume();
    let finish: () => void = () => undefined;
    const request = drain.admit(
      () =>
        new Promise<string>((resolve) => {
          finish = () => {
            resolve("done");
          };
        }),
    );
    const draining = drain.drain({ drainUntil: "2026-09-14T10:00:01.000Z" });
    finish();
    expect(await request).toBe("done");
    expect(await draining).toBe("drained");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an expired drain when a request outlives the deadline", async () => {
    vi.useFakeTimers();
    const drain = new RequestDrain(() => Date.parse("2026-09-14T10:00:00.000Z"));
    void drain.admit(() => new Promise(() => undefined));
    const draining = drain.drain({ drainUntil: "2026-09-14T10:00:00.500Z" });
    await vi.advanceTimersByTimeAsync(499);
    let result: string | undefined;
    void draining.then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await draining).toBe("expired");
    const concurrent = new RequestDrain();
    let first: () => void = () => undefined;
    const running = concurrent.admit(
      () =>
        new Promise<void>((resolve) => {
          first = resolve;
        }),
    );
    void concurrent.admit(() => new Promise<void>(() => undefined));
    let outcome: string | undefined;
    const pending = concurrent.drain({ drainUntil: new Date(Date.now() + 10).toISOString() });
    void pending.then((value) => {
      outcome = value;
    });
    first();
    await running;
    await vi.advanceTimersByTimeAsync(9);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("expired");
    const late = new RequestDrain(() => Date.parse("2026-09-14T10:00:01.000Z"));
    void late.admit(() => new Promise(() => undefined));
    const immediate = late.drain({ drainUntil: "2026-09-14T10:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await immediate).toBe("expired");
  });
});

describe("teacher host status file", () => {
  it("replaces a private status record atomically and ignores unreadable content", async () => {
    const statusPath = join(mkdtempSync(join(tmpdir(), "marea-host-status-")), "status.json");
    const status = createFileHostStatus();
    expect(await status.read({ installationRoot: "/", statusPath })).toBeNull();
    const value = {
      status: "ready" as const,
      releaseId: "release:one",
      schemaVersion: 9,
      reasonCode: "ready",
      observedAt: "2026-09-14T10:00:00.000Z",
    };
    await status.write({ installationRoot: "/", statusPath, value });
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual(value);
    expect(statSync(statusPath).mode & 0o777).toBe(0o600);
    expect(await status.read({ installationRoot: "/", statusPath })).toEqual(value);
    for (const state of ["starting", "draining", "stopped", "failed"] as const) {
      await status.write({ installationRoot: "/", statusPath, value: { ...value, status: state } });
      expect(await status.read({ installationRoot: "/", statusPath })).toEqual({
        ...value,
        status: state,
      });
    }
    writeFileSync(statusPath, JSON.stringify({ ...value, extra: true }));
    expect(await status.read({ installationRoot: "/", statusPath })).toBeNull();
    await expect(
      status.write({
        installationRoot: "/",
        statusPath,
        value: { ...value, status: "unknown" as never },
      }),
    ).rejects.toThrow();
  });
});

describe("Bun HTTP listener", () => {
  it("serves through Bun and stops closing active connections", async () => {
    const stop = vi.fn(() => Promise.resolve());
    const serve = vi.fn(() => ({ url: new URL("http://127.0.0.1:4321/"), stop }));
    vi.stubGlobal("Bun", { serve });
    const fetch = () => Promise.resolve(new Response("ok"));
    const server = bunServe({ hostname: "127.0.0.1", port: 0, fetch });
    expect(serve).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 0,
      fetch: expect.any(Function) as typeof fetch,
      websocket: expect.objectContaining({
        idleTimeout: 60,
        maxPayloadLength: 1024,
        backpressureLimit: 256 * 1024,
        closeOnBackpressureLimit: true,
      }) as object,
    });
    expect(server.url).toBe("http://127.0.0.1:4321");
    await server.stop();
    expect(stop).toHaveBeenCalledWith(true);
    expect(Object.isFrozen(server)).toBe(true);
  });
});

it.each([null, "application/json", "application/x-ndjson; charset=utf-8"])(
  "delegates only model stream idleness to the inference deadline (%s)",
  async (contentType) => {
    const serve = vi.fn();
    serve.mockReturnValue({ url: new URL("http://127.0.0.1:4321/"), stop: vi.fn() });
    vi.stubGlobal("Bun", { serve });
    const request = new Request("http://127.0.0.1/v1/model/stream", { method: "POST" });
    const response = new Response(null, {
      headers: contentType === null ? {} : { "content-type": contentType },
    });
    const handler = vi.fn(() => Promise.resolve(response));
    bunServe({ hostname: "127.0.0.1", port: 0, fetch: handler });
    const options = serve.mock.calls[0]?.[0] as {
      fetch(
        request: Request,
        listener: { timeout: (request: Request, seconds: number) => void },
      ): Promise<Response>;
    };
    const timeout = vi.fn();
    expect(await options.fetch(request, { timeout })).toBe(response);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
    if (contentType === "application/x-ndjson; charset=utf-8")
      expect(timeout).toHaveBeenCalledExactlyOnceWith(request, 0);
    else expect(timeout).not.toHaveBeenCalled();
  },
);
