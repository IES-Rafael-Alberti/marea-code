import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryExporterDestination } from "@marea/plugin-api";
import { createOperationalTelemetry } from "./operational-policy.js";
import { enabledConfiguration, operationalSample } from "./operational-policy.fixture.js";
import { createFakeExporter, type FakeExporter } from "./telemetry.fixture.js";

export { createFakeExporter } from "./telemetry.fixture.js";
export type { FakeExporter, FakeExporterBehaviors } from "./telemetry.fixture.js";

export type ExporterConformanceScenario =
  "success" | "failure" | "export-timeout" | "shutdown-timeout" | "shutdown-failure";

/** A fresh candidate for every test; local fake transport only. No external network. */
export type ExporterConformanceHarness = (scenario: ExporterConformanceScenario) => FakeExporter;

/** Verifies host/port integration, not vendor wire mapping or real I/O cancellation. */
export function defineTelemetryExporterConformance(
  destination: TelemetryExporterDestination,
  createHarness: ExporterConformanceHarness,
): void {
  describe(`${destination} shared exporter conformance`, () => {
    afterEach(() => vi.useRealTimers());
    const signal = () => new AbortController().signal;
    const prepare = (scenario: ExporterConformanceScenario) => {
      const candidate = createHarness(scenario);
      const peer = createFakeExporter("peer");
      const other = destination === "otlp" ? "langfuse" : "otlp";
      const runtime = createOperationalTelemetry(
        {
          ...enabledConfiguration,
          destinations: [destination, other],
          operationTimeoutMs: 10,
          maxInFlight: 1,
        },
        { [destination]: candidate.port, [other]: peer.port },
      );
      return { candidate, peer, runtime };
    };
    it("delivers the same deeply frozen sanitized envelope and closes only once", async () => {
      const { candidate, peer, runtime } = prepare("success");
      const expected = runtime.preview(operationalSample());
      expect(candidate.exported).toEqual([]);
      expect((await runtime.emit(operationalSample(), signal())).outcomes).toEqual([
        { exporterId: destination, status: "succeeded" },
        { exporterId: destination === "otlp" ? "langfuse" : "otlp", status: "succeeded" },
      ]);
      expect(candidate.exported).toEqual([expected]);
      expect(candidate.exported[0]).toBe(peer.exported[0]);
      for (const item of [
        candidate.exported[0],
        candidate.exported[0]?.attributes,
        candidate.exported[0]?.attributes[0],
        candidate.exported[0]?.resource,
      ])
        expect(Object.isFrozen(item)).toBe(true);
      expect(JSON.stringify(candidate.exported)).not.toContain("private");
      const closing = runtime.close(signal());
      expect(runtime.close(signal())).toBe(closing);
      expect((await runtime.emit(operationalSample(), signal())).status).toBe("closed");
      expect((await closing).outcomes.every(({ status }) => status === "succeeded")).toBe(true);
      expect(candidate.shutdownSignals).toHaveLength(1);
    });
    it("isolates failure and exposes no adapter errors or private IDs", async () => {
      const { runtime, peer } = prepare("failure");
      const report = await runtime.emit(operationalSample(), signal());
      expect(report.outcomes[0]).toEqual({ exporterId: destination, status: "failed" });
      expect(report.outcomes[1]?.status).toBe("succeeded");
      expect(peer.exported).toHaveLength(1);
      expect(JSON.stringify(report)).not.toMatch(/secret|private|https|stack|cause/);
      await runtime.close(signal());
    });
    it("sanitizes shutdown failures without blocking its peer", async () => {
      const { runtime, peer } = prepare("shutdown-failure");
      const report = await runtime.close(signal());
      expect(report.outcomes[0]).toEqual({ exporterId: destination, status: "failed" });
      expect(report.outcomes[1]?.status).toBe("succeeded");
      expect(peer.shutdownSignals).toHaveLength(1);
      expect(JSON.stringify(report)).not.toMatch(/secret|private|https|stack|cause/);
    });
    it("skips pre-cancelled exports and shuts down with a fresh signal", async () => {
      const { candidate, runtime } = prepare("success");
      const controller = new AbortController();
      controller.abort();
      const report = await runtime.emit(operationalSample(), controller.signal);
      expect(report.outcomes.every(({ status }) => status === "cancelled")).toBe(true);
      expect(candidate.exported).toEqual([]);
      await runtime.close(signal());
      expect(candidate.shutdownSignals).toHaveLength(1);
    });
    it.each(["timeout", "cancel"])("bounds admission and interrupts export on %s", async (mode) => {
      vi.useFakeTimers();
      const { candidate, peer, runtime } = prepare("export-timeout");
      const controller = new AbortController();
      const pending = runtime.emit(operationalSample(), controller.signal);
      expect((await runtime.emit(operationalSample(), signal())).status).toBe("busy");
      expect(candidate.exported).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(candidate.exportSignals[0]?.aborted).toBe(false);
      if (mode === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      expect((await pending).outcomes[0]?.status).toBe(
        mode === "cancel" ? "cancelled" : "timed-out",
      );
      expect(candidate.exportSignals[0]?.aborted).toBe(true);
      expect(peer.exported).toHaveLength(1);
      expect((await runtime.emit(operationalSample(), signal())).status).toBe("unavailable");
      await runtime.close(signal());
      expect(candidate.shutdownSignals).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
    it.each(["timeout", "cancel"])("bounds shutdown on %s", async (mode) => {
      vi.useFakeTimers();
      const { candidate, runtime } = prepare("shutdown-timeout");
      const controller = new AbortController();
      const closing = runtime.close(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      expect((await closing).outcomes[0]?.status).toBe(
        mode === "cancel" ? "cancelled" : "timed-out",
      );
      expect(candidate.shutdownSignals[0]?.aborted).toBe(true);
      expect(runtime.close(signal())).toBe(closing);
      expect(candidate.shutdownSignals).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}
