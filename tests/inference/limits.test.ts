import { describe, expect, it } from "vitest";

import { createHttpModelGateway } from "../../apps/student/src/http-client.boundary.js";
import { RouteBudgetSchema } from "../../apps/teacher-server/src/model-gateway/route-policy.js";
import { SqliteUsageLedger } from "../../apps/teacher-server/src/platform/persistence/sqlite-usage-ledger.js";
import { USAGE_POLICY } from "../../apps/teacher-server/test-support/usage-fixture.js";
import {
  ModelGatewayRequestSchema,
  OpenRunRequestSchema,
} from "../../packages/protocol/src/index.js";
import {
  acceptanceSnapshot,
  createAcceptanceHarness,
  enrollAcceptanceStudent,
  type AcceptanceHarness,
} from "../../test-support/acceptance/harness.js";

async function open(harness: AcceptanceHarness, name: "ada" | "bob") {
  const identity = await enrollAcceptanceStudent(harness, name);
  const request = OpenRunRequestSchema.parse({
    protocolVersion: "0.1",
    clientVersion: "0.2.0",
    requestId: `request:open:${name}`,
    idempotencyKey: `open:${name}`,
    clientSessionId: `client:${name}`,
    intent: { kind: "new" },
    project: { displayName: "Synthetic budget project" },
  });
  return {
    identity,
    request,
    opened: await harness.studentServer.openRun(identity.session.token, request),
  };
}

const query = (requestId: string) =>
  ModelGatewayRequestSchema.parse({
    kind: "model-gateway-request",
    protocolVersion: "0.1",
    modelAlias: "marea",
    requestId,
    messages: [{ role: "student", content: "Hello." }],
    tools: [],
  });

describe("enforced inference over real HTTP", () => {
  it("isolates concurrent students, retains interrupted charges and preserves captured limits after a class edit", async () => {
    let budget = RouteBudgetSchema.parse({
      inputTokenCeiling: 10,
      tutoring: { ...USAGE_POLICY, maxRequests: 2 },
      evaluation: USAGE_POLICY,
    });
    const harness = await createAcceptanceHarness({
      snapshotSource: () => ({
        capture: (id) => ({
          snapshot: acceptanceSnapshot(id),
          providerRoute: {
            model: "deterministic-upstream",
            providerId: "test.deterministic",
            budget,
          },
        }),
      }),
    });
    try {
      const ada = await open(harness, "ada");
      const bob = await open(harness, "bob");
      const gateway = (token: typeof ada.opened.lease.token) =>
        createHttpModelGateway({
          baseUrl: harness.http.baseUrl,
          runToken: () => Promise.resolve(token),
        });
      const adaGateway = gateway(ada.opened.lease.token);
      const bobGateway = gateway(bob.opened.lease.token);
      const control = harness.provider.controlNextAfterText("Partial response.");
      const cancellation = new AbortController();
      const firstStream = adaGateway.stream(query("request:first"), cancellation.signal);
      const pending = firstStream[Symbol.asyncIterator]();
      expect((await pending.next()).value).toMatchObject({ event: "started" });
      expect((await pending.next()).value).toMatchObject({
        event: "text-delta",
        delta: "Partial response.",
      });
      const denied = await Array.fromAsync(
        adaGateway.stream(query("request:competing"), new AbortController().signal),
      );
      expect(denied.at(-1)).toMatchObject({
        event: "failed",
        code: "concurrency-limited",
        retryable: true,
      });
      const bobEvents = await Array.fromAsync(
        bobGateway.stream(query("request:first"), new AbortController().signal),
      );
      expect(bobEvents.at(-1)).toMatchObject({ event: "completed" });
      expect(harness.provider.requests).toHaveLength(2);
      cancellation.abort();
      // eslint-disable-next-line @typescript-eslint/no-restricted-types -- External stream rejection is immediately matched, never used as trusted data.
      await pending.return?.().catch((error: unknown) => {
        expect(error).toMatchObject({ code: "request.cancelled", retryable: false });
      });
      await control.cancellationObserved;
      // Allow the server's cancellation cleanup to settle its durable reservation.
      const ledger = new SqliteUsageLedger(harness.database);
      for (
        let check = 0;
        check < 20 &&
        ledger.totals({ runId: ada.opened.lease.runId, purpose: "tutoring" }).inFlight !== 0;
        check++
      )
        await new Promise((resolve) => setImmediate(resolve));
      expect(ledger.totals({ runId: ada.opened.lease.runId, purpose: "tutoring" })).toEqual({
        requests: 1,
        tokens: 20,
        costUnits: 50,
        inFlight: 0,
      });
      budget = RouteBudgetSchema.parse({
        ...budget,
        tutoring: { ...budget.tutoring, maxRequests: 100 },
      });
      const next = await Array.fromAsync(
        adaGateway.stream(query("request:second"), new AbortController().signal),
      );
      expect(next.at(-1)).toMatchObject({ event: "completed" });
      const exhausted = await Array.fromAsync(
        adaGateway.stream(query("request:third"), new AbortController().signal),
      );
      expect(exhausted.at(-1)).toMatchObject({ event: "failed", retryable: false });
      expect(harness.provider.requests).toHaveLength(3);
      expect(harness.provider.requests.every((request) => request.maxOutputTokens === 10)).toBe(
        true,
      );
      const clientOutput = JSON.stringify([ada.opened, bobEvents, denied, next, exhausted]);
      for (const privateValue of [
        "deterministic-upstream",
        "test.deterministic",
        "maxCostUnits",
        "inputCostUnitsPerToken",
      ])
        expect(clientOutput).not.toContain(privateValue);
      const newer = await harness.studentServer.openRun(
        ada.identity.session.token,
        OpenRunRequestSchema.parse({
          ...ada.request,
          requestId: "request:new",
          idempotencyKey: "open:new",
          clientSessionId: "client:new",
        }),
      );
      const fresh = await Array.fromAsync(
        gateway(newer.lease.token).stream(query("request:fresh"), new AbortController().signal),
      );
      expect(fresh.at(-1)).toMatchObject({ event: "completed" });
      expect(
        harness.database.readOne("SELECT policy_json FROM marea_usage_accounts WHERE run_id = ?1", [
          newer.lease.runId,
        ])?.policy_json,
      ).toContain('"maxRequests":100');
    } finally {
      await harness.close();
    }
  });

  it("keeps legacy snapshots readable but refuses unconfigured inference before contacting a provider", async () => {
    const harness = await createAcceptanceHarness({
      snapshotSource: () => ({
        capture: (id) => ({
          snapshot: acceptanceSnapshot(id),
          providerRoute: {
            model: "deterministic-upstream",
            providerId: "test.deterministic",
          },
        }),
      }),
    });
    try {
      const ada = await open(harness, "ada");
      const gateway = createHttpModelGateway({
        baseUrl: harness.http.baseUrl,
        runToken: () => Promise.resolve(ada.opened.lease.token),
      });
      await expect(
        Array.fromAsync(gateway.stream(query("request:legacy"), new AbortController().signal)),
      ).rejects.toMatchObject({
        status: 503,
        retryable: false,
      });
      expect(harness.provider.requests).toEqual([]);
      expect(harness.database.readAll("SELECT id FROM marea_usage_attempts")).toEqual([]);
      expect(ada.opened.snapshot.prompt.content).toBe(
        "Help the student reason before changing a file.",
      );
    } finally {
      await harness.close();
    }
  });
});
