import { describe, expect, it } from "vitest";

import { NOW, setup } from "../../test-support/history-fixture.js";
import { USAGE_ACCOUNT, USAGE_POLICY, USAGE_REQUEST } from "../../test-support/usage-fixture.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { RecordingProvider } from "../product-http/product-http.fixture.js";
import { cancellationFor } from "./inference-cancellation.js";
import { RunInferenceService } from "./run-inference-service.js";

describe("authorized run inference composition", () => {
  it("admits only a captured budget and keeps repeated configuration and request correlation stable", async () => {
    const { database } = setup();
    try {
      const ledger = new SqliteUsageLedger(database);
      let index = 0;
      const service = new RunInferenceService({
        ledger,
        clock: { now: () => NOW },
        createReservationId: () => `attempt:service:${String(++index)}`,
      });
      const provider = new RecordingProvider();
      const legacy = {
        runId: USAGE_ACCOUNT.runId,
        studentId: "s1",
        providerRoute: { providerId: "synthetic", model: "synthetic" },
      };
      expect(service.providerFor(legacy, USAGE_REQUEST.requestId, provider)).toBeNull();
      expect(database.readAll("SELECT * FROM marea_usage_accounts")).toEqual([]);
      const lease = {
        ...legacy,
        providerRoute: {
          ...legacy.providerRoute,
          budget: {
            inputTokenCeiling: 10,
            tutoring: USAGE_POLICY,
            evaluation: { ...USAGE_POLICY, maxRequests: 0 },
          },
        },
      };
      for (const requestId of ["request:first", "request:second"]) {
        const metered = service.providerFor(lease, requestId, provider);
        if (metered === null) throw new Error("Expected a configured provider.");
        const events = await Array.fromAsync(
          metered.stream(
            { ...USAGE_REQUEST, requestId },
            cancellationFor(new AbortController().signal),
          ),
        );
        expect(events.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
      }
      expect(
        provider.requests.map((request) => [request.requestId, request.maxOutputTokens]),
      ).toEqual([
        ["request:first", 10],
        ["request:second", 10],
      ]);
      expect(
        database.readAll("SELECT id, created_at FROM marea_usage_attempts ORDER BY id"),
      ).toEqual([
        { id: "attempt:service:1", created_at: NOW },
        { id: "attempt:service:2", created_at: NOW },
      ]);
      expect(ledger.totals(USAGE_ACCOUNT)).toEqual({
        requests: 2,
        tokens: 14,
        costUnits: 34,
        inFlight: 0,
      });
      expect(ledger.totals({ ...USAGE_ACCOUNT, purpose: "evaluation" }).requests).toBe(0);
      expect(() =>
        service.providerFor(
          {
            ...lease,
            providerRoute: {
              ...lease.providerRoute,
              budget: {
                ...lease.providerRoute.budget,
                tutoring: { ...USAGE_POLICY, maxRequests: 4 },
              },
            },
          },
          "request:retroactive",
          provider,
        ),
      ).toThrow("request.conflict");
    } finally {
      database.close();
    }
  });
});
