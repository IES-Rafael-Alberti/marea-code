import { describe, expect, it, vi } from "vitest";

import { dependencyHarness, index } from "./host-test-fixtures.fixture.js";
import { diagnosticEvidence, diagnosticLock, validDeadline } from "./runtime-support.js";

describe("host runtime support boundaries", () => {
  it("accepts only valid non-expired deadlines", () => {
    expect(validDeadline("2026-09-13T12:00:00.000Z", "2026-09-13T11:59:59.999Z")).toBe(true);
    expect(validDeadline("2026-09-13T11:59:59.999Z", "2026-09-13T12:00:00.000Z")).toBe(false);
    expect(validDeadline("invalid", "2026-09-13T12:00:00.000Z")).toBe(false);
    expect(validDeadline("2026-09-13T12:00:00.000Z", "invalid")).toBe(false);
    expect(validDeadline("2026-09-13T13:00:00.000Z", "2026-09-13T12:00:00")).toBe(false);
  });

  it("acquires diagnostics only for a free observation", async () => {
    const harness = dependencyHarness();
    await expect(
      diagnosticLock(harness.dependencies, "/synthetic/installation", "held"),
    ).resolves.toBe(null);
    await expect(
      diagnosticLock(harness.dependencies, "/synthetic/installation", "unknown"),
    ).resolves.toBe(null);
    await expect(
      diagnosticLock(harness.dependencies, "/synthetic/installation", "free"),
    ).resolves.toEqual(expect.objectContaining({ canonicalRoot: "/synthetic/installation" }));
    const raced = dependencyHarness({
      exclusivity: {
        acquire: vi.fn(() => Promise.reject(new Error("raced"))),
        inspect: vi.fn(() => Promise.resolve("free" as const)),
      },
    });
    await expect(
      diagnosticLock(raced.dependencies, "/synthetic/installation", "free"),
    ).resolves.toBe(null);
  });

  it("uses canonical ownership evidence and reports stale indexes", async () => {
    const harness = dependencyHarness({
      index: { inspect: vi.fn(() => Promise.resolve({ ...index, state: "uncertain" as const })) },
      exclusivity: {
        acquire: vi.fn(() =>
          Promise.resolve({
            canonicalRoot: "/canonical/installation",
            release: vi.fn(() => Promise.resolve()),
          }),
        ),
        inspect: vi.fn(() => Promise.resolve("free" as const)),
      },
    });
    const lock = await diagnosticLock(harness.dependencies, "/synthetic/installation", "free");
    const evidence = await diagnosticEvidence(
      harness.dependencies,
      "/synthetic/installation",
      lock,
      "lock-free",
    );
    expect(evidence.checks).toEqual(["lock-free", "config-valid", "stale-status"]);
    expect(evidence.ownershipLost).toBe(false);
    const read = Reflect.get(harness.dependencies.configuration, "read") as ReturnType<
      typeof vi.fn
    >;
    expect(read).toHaveBeenCalledWith({
      installationRoot: "/canonical/installation",
    });
  });

  it("disposes terminal diagnostic owners without retaining them", async () => {
    for (const releaseState of ["released", "ownership-lost"] as const) {
      const harness = dependencyHarness();
      const lock = {
        canonicalRoot: "/synthetic/installation",
        releaseState,
        release: vi.fn(() => Promise.reject(new Error("release failed"))),
      };
      const evidence = await diagnosticEvidence(
        harness.dependencies,
        "/synthetic/installation",
        lock,
        "lock-free",
      );
      expect(evidence.lock).toBeNull();
      expect(evidence.ownershipLost).toBe(releaseState === "ownership-lost");
    }
  });
});
