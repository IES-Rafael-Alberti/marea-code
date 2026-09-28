import { describe, expect, it } from "vitest";

import {
  OfflineDiagnosisSchema,
  RecoveryInspectionSchema,
  ShutdownResultSchema,
  StartResultSchema,
} from "./contracts.js";

describe("OPERATIONS public lifecycle and recovery schemas", () => {
  it("accepts every lifecycle result variant and rejects malformed payloads", () => {
    expect(
      StartResultSchema.parse({ state: "ready", releaseId: "release-1", schemaVersion: 8 }),
    ).toMatchObject({ state: "ready" });
    for (const reason of [
      "lock",
      "config",
      "release",
      "storage",
      "recovery",
      "index",
      "assets",
      "listen",
    ] as const)
      expect(StartResultSchema.parse({ state: "failed", reason })).toMatchObject({ reason });
    expect(
      StartResultSchema.safeParse({ state: "ready", releaseId: "", schemaVersion: 8 }).success,
    ).toBe(false);
    expect(
      StartResultSchema.safeParse({ state: "ready", releaseId: "release-1", schemaVersion: -1 })
        .success,
    ).toBe(false);
    expect(
      OfflineDiagnosisSchema.parse({
        mode: "offline-validation",
        observedAt: "2026-09-13T10:00:00Z",
        status: "ready",
        releaseId: "release-1",
        schemaVersion: 8,
        checks: [],
        reasonCode: "diagnostic",
      }),
    ).toMatchObject({ releaseId: "release-1" });
    for (const state of ["stopped", "drain-expired", "failed"] as const)
      expect(ShutdownResultSchema.parse({ state, reasonCode: "reason-1" })).toMatchObject({
        state,
      });
    expect(ShutdownResultSchema.safeParse({ state: "stopped", reasonCode: "" }).success).toBe(
      false,
    );
  });

  it("accepts every diagnosis and recovery inspection state with strict fields", () => {
    const checks = [
      "lock-free",
      "lock-held",
      "config-valid",
      "release-valid",
      "index-valid",
      "index-missing",
      "stale-status",
    ] as const;
    for (const mode of ["live-host-observed", "offline-validation"] as const)
      for (const status of [
        "starting",
        "ready",
        "draining",
        "stopped",
        "failed",
        "unknown",
      ] as const)
        expect(
          OfflineDiagnosisSchema.parse({
            mode,
            observedAt: "2026-09-13T10:00:00Z",
            status,
            releaseId: null,
            schemaVersion: null,
            checks,
            reasonCode: "diagnostic",
          }),
        ).toMatchObject({ mode, status });
    expect(
      OfflineDiagnosisSchema.safeParse({
        mode: "offline-validation",
        observedAt: "",
        status: "ready",
        releaseId: null,
        schemaVersion: null,
        checks: [],
        reasonCode: "diagnostic",
      }).success,
    ).toBe(false);
    for (const state of [
      "none",
      "prepared",
      "index-committed",
      "content-complete",
      "applied",
      "failed",
      "uncertain",
      "blocked",
    ] as const)
      expect(
        RecoveryInspectionSchema.parse({
          state,
          operationId: null,
          checkpoint: null,
          reasonCode: "recovery",
        }),
      ).toMatchObject({ state });
    expect(
      RecoveryInspectionSchema.parse({
        state: "prepared",
        operationId: "operation-1",
        checkpoint: null,
        reasonCode: "recovery",
      }),
    ).toMatchObject({ operationId: "operation-1" });
    expect(
      RecoveryInspectionSchema.safeParse({
        state: "none",
        operationId: null,
        checkpoint: null,
        reasonCode: "",
      }).success,
    ).toBe(false);
  });
});
