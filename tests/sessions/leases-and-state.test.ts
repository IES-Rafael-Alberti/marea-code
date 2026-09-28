import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AppendRunEventsRequestSchema,
  EventIdSchema,
  RequestIdSchema,
  RunTokenSchema,
} from "../../packages/protocol/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import {
  createFileStudentStores,
  parseStudentState,
} from "../../apps/student/src/filesystem.boundary.js";
import { LocalSession } from "../../apps/student/src/local-session.js";
import { createSystemIdSource } from "../../apps/student/src/platform.boundary.js";
import { AcceptanceResources, enroll, openRun } from "../../test-support/acceptance/resources.js";
import { MutableTestClock } from "../../test-support/acceptance/harness.js";

const MutableStateFileSchema = z
  .object({
    futureRootField: z.json().optional(),
    run: z.record(z.string(), z.json()),
  })
  .loose();

type MutableStateFile = z.infer<typeof MutableStateFileSchema>;

const resources = new AcceptanceResources();

afterEach(async () => resources.close());

async function priorState(prefix: string) {
  const location = await resources.project(prefix);
  const stores = await createFileStudentStores(location);
  const local = new LocalSession(stores.state, createSystemIdSource(), new MutableTestClock());
  await local.ensureOpening("Prior valid project", { kind: "new" });
  const statePath = join(location.stateDirectory, "session.json");
  const prior: MutableStateFile = MutableStateFileSchema.parse(
    JSON.parse(await readFile(statePath, "utf8")),
  );
  expect(() => parseStudentState(prior)).not.toThrow();
  return { prior, statePath, stores };
}

describe("lease and state acceptance contracts", () => {
  it("renews an expired lease through the authenticated client contract and sends the next message", async () => {
    const value = await resources.harness();
    const ada = await enroll(value, "ada");
    const opened = await openRun(value, ada.session.token, "renewal");
    value.clock.advance(10 * 60 * 1_000);
    const requestId = RequestIdSchema.parse("request:lease-renewal");
    const issuedAt = value.clock.now();
    const expiresAt = new Date(Date.parse(issuedAt) + 10 * 60 * 1_000).toISOString();

    const renewed = await value.studentServer.renewLease(ada.session.token, {
      kind: "run-lease-renewal",
      protocolVersion: "0.1",
      requestId,
      runId: opened.lease.runId,
    });

    expect(renewed).toEqual({
      kind: "run-lease-renewed",
      protocolVersion: "0.1",
      requestId,
      lease: {
        expiresAt,
        issuedAt,
        runId: opened.lease.runId,
        token: renewed.lease.token,
      },
    });
    expect(RunTokenSchema.parse(renewed.lease.token)).toBe(renewed.lease.token);
    expect(renewed.lease.token).not.toBe(opened.lease.token);
    const nextMessage = AppendRunEventsRequestSchema.parse({
      events: [
        {
          content: "Message after renewal",
          eventId: EventIdSchema.parse("event:after-renewal"),
          eventType: "student-message",
          messageId: "message:after-renewal",
          occurredAt: value.clock.now(),
          sequence: 2,
        },
      ],
      kind: "run-events-append",
      protocolVersion: "0.1",
      requestId: "request:after-renewal",
    });
    await expect(
      value.studentServer.appendRunEvents(renewed.lease.token, nextMessage),
    ).resolves.toEqual({
      highestDurableSequence: 2,
      kind: "run-events-acknowledged",
      protocolVersion: "0.1",
      requestId: "request:after-renewal",
    });
    expect(
      value.database.readAll(
        "SELECT event_id, payload_json, sequence FROM marea_run_events ORDER BY sequence",
      ),
    ).toEqual([
      expect.objectContaining({ sequence: 1n }),
      {
        event_id: "event:after-renewal",
        payload_json: JSON.stringify(nextMessage.events[0]),
        sequence: 2n,
      },
    ]);
  });

  it("migrates an actual prior state and preserves unknown root and run fields", async () => {
    const { prior, statePath, stores } = await priorState("marea-acceptance-state-migration-");
    delete prior.version;
    delete prior.run.leaseExpiresAt;
    delete prior.run.leaseIssuedAt;
    delete prior.run.pendingApprovals;
    delete prior.run.pendingDelivery;
    prior.futureRootField = { retained: true };
    prior.run.futureRunField = ["retained"];
    await writeFile(statePath, JSON.stringify(prior), "utf8");

    const migrated = await stores.state.load();

    expect(migrated.legacy).toEqual({ futureRootField: { retained: true } });
    expect(migrated.run?.legacy).toEqual({ futureRunField: ["retained"] });
    expect(migrated.run?.pendingApprovals).toEqual([]);
    expect(migrated.run).toMatchObject({
      pendingDelivery: null,
      leaseExpiresAt: null,
      leaseIssuedAt: null,
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(migrated);
    await stores.state.save(migrated);
    await expect(stores.state.load()).resolves.toMatchObject({
      legacy: { futureRootField: { retained: true } },
      run: { legacy: { futureRunField: ["retained"] } },
    });
  });

  it("rejects ambiguous prior state without rewriting or losing it", async () => {
    const { prior, statePath, stores } = await priorState("marea-acceptance-state-invalid-");
    prior.run.eventKeys = ["duplicate-identity", "duplicate-identity"];
    const ambiguous = JSON.stringify(prior);
    await writeFile(statePath, ambiguous, "utf8");

    await expect(stores.state.load()).rejects.toMatchObject({ name: "ZodError" });
    await expect(readFile(statePath, "utf8")).resolves.toBe(ambiguous);
  });

  it("rejects an unresumable started turn from actual prior state without rewriting it", async () => {
    const location = await resources.project("marea-acceptance-state-started-");
    const stores = await createFileStudentStores(location);
    const local = new LocalSession(stores.state, createSystemIdSource(), new MutableTestClock());
    await local.ensureOpening("Prior interrupted project", { kind: "new" });
    await local.setTurn({ messageId: "message:legacy-started", state: "started" });
    const statePath = join(location.stateDirectory, "session.json");
    const prior = MutableStateFileSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
    expect(() => parseStudentState(prior)).not.toThrow();
    delete prior.version;
    const ambiguous = JSON.stringify(prior);
    await writeFile(statePath, ambiguous, "utf8");

    await expect(stores.state.load()).rejects.toThrow(/ambiguous.*unfinished turn/iu);
    await expect(readFile(statePath, "utf8")).resolves.toBe(ambiguous);
  });
});
