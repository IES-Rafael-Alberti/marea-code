import {
  AppendRunEventsRequestSchema,
  CanonicalRunEventSchema,
  OpenRunRequestSchema,
  STARTUP_MESSAGE_ID,
  type CanonicalRunEvent,
} from "@marea/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { teachingInput, teachingSkill } from "../../../test-support/teaching-fixture.js";
import {
  clock,
  newRun,
  seedTeachingDatabase,
  servicesFor,
  student,
  teacher,
} from "../../../test-support/teaching-integration.fixture.js";
import { loadRunStartup, validateStartupEvent } from "./sqlite-run-startup.js";

function lifecycle(
  state: "started" | "completed" | "cancelled",
  sequence: number,
  id: string = state,
): CanonicalRunEvent {
  return CanonicalRunEventSchema.parse({
    eventType: "tutor-startup",
    state,
    sequence,
    eventId: `event:${id}`,
    occurredAt: clock.now(),
  });
}

function request(events: readonly CanonicalRunEvent[]) {
  return AppendRunEventsRequestSchema.parse({
    kind: "run-events-append",
    protocolVersion: "0.1",
    requestId: "request:startup",
    events,
  });
}

describe("SQLite tutor startup lifecycle", () => {
  let database: NodeSqliteTestDatabase;
  let services: ReturnType<typeof servicesFor>;

  beforeEach(async () => {
    database = new NodeSqliteTestDatabase();
    seedTeachingDatabase(database);
    const bundles = [teachingSkill("didactic"), teachingSkill("evaluation")];
    services = servicesFor(database, {
      list: (kind) => Promise.resolve(bundles.filter((bundle) => bundle.kind === kind)),
      load: (id) => Promise.resolve(bundles.find((bundle) => bundle.id === id) ?? null),
    });
    await services.teaching.save(teacher, teachingInput());
  });
  it("admits external student changes during startup while rejecting agent writes", () => {
    const opened = services.runs.open(student, newRun("startup-external-edits"));
    services.runs.append(opened.lease.token, request([lifecycle("started", 2)]));
    const change = CanonicalRunEventSchema.parse({
      eventType: "project-change",
      eventId: "event:startup-change",
      sequence: 3,
      occurredAt: clock.now(),
      messageId: STARTUP_MESSAGE_ID,
      actor: "student",
      summary: "External edit",
      patch: "+student work",
      truncated: false,
    });
    expect(() =>
      services.runs.append(
        opened.lease.token,
        request([CanonicalRunEventSchema.parse({ ...change, actor: "agent" })]),
      ),
    ).toThrow("request.conflict");
    expect(services.runs.append(opened.lease.token, request([change])).highestDurableSequence).toBe(
      3,
    );
  });
  it.each(["assistant-progress", "turn-failed"] as const)(
    "admits %s during startup only after its start marker",
    (eventType) => {
      const opened = services.runs.open(student, newRun(`startup-${eventType}`));
      const event = CanonicalRunEventSchema.parse({
        eventType,
        eventId: `event:${eventType}`,
        messageId: STARTUP_MESSAGE_ID,
        sequence: 3,
        occurredAt: clock.now(),
        ...(eventType === "assistant-progress"
          ? { content: "Beginning", truncated: false }
          : { category: "offline", retryable: true }),
      });
      services.runs.append(opened.lease.token, request([lifecycle("started", 2)]));
      expect(
        services.runs.append(opened.lease.token, request([event])).highestDurableSequence,
      ).toBe(3);
    },
  );
  afterEach(() => {
    database.close();
  });

  it.each(["completed", "cancelled"] as const)(
    "persists pending → started → %s without duplicate admission",
    (terminal) => {
      const opened = services.runs.open(student, newRun(`first-${terminal}`));
      expect(opened.startupState).toBe("pending");
      const started = request([lifecycle("started", 2)]);
      expect(services.runs.append(opened.lease.token, started).highestDurableSequence).toBe(2);
      expect(services.runs.append(opened.lease.token, started).highestDurableSequence).toBe(2);
      expect(loadRunStartup(database, opened.lease.runId, opened.snapshot)).toBe("started");
      const assistant = CanonicalRunEventSchema.parse({
        eventType: "assistant-message",
        messageId: STARTUP_MESSAGE_ID,
        content: "One exercise.",
        eventId: "event:assistant",
        occurredAt: clock.now(),
        sequence: 3,
      });
      services.runs.append(opened.lease.token, request([assistant, lifecycle(terminal, 4)]));
      const resumed = services.runs.open(
        student,
        OpenRunRequestSchema.parse({
          ...newRun(`resume-${terminal}`),
          runId: opened.lease.runId,
          intent: { kind: "resume" },
        }),
      );
      expect(resumed.startupState).toBe(terminal);
      expect(resumed.highestDurableSequence).toBe(4);
      expect(
        services.runs.append(resumed.lease.token, request([assistant, lifecycle(terminal, 4)]))
          .highestDurableSequence,
      ).toBe(4);
      expect(() =>
        services.runs.append(resumed.lease.token, request([lifecycle("started", 5, "restarted")])),
      ).toThrow("request.conflict");
      const second = services.runs.open(student, newRun(`second-${terminal}`));
      expect(second.startupState).toBe("pending");
      expect(loadRunStartup(database, opened.lease.runId, opened.snapshot)).toBe(terminal);
    },
  );

  it("rejects completion before admission and reserves the internal assistant identity", () => {
    const opened = services.runs.open(student, newRun("invalid"));
    expect(() =>
      services.runs.append(opened.lease.token, request([lifecycle("completed", 2)])),
    ).toThrow("request.conflict");
    const assistant = CanonicalRunEventSchema.parse({
      eventType: "assistant-message",
      messageId: STARTUP_MESSAGE_ID,
      content: "Too early.",
      eventId: "event:early",
      occurredAt: clock.now(),
      sequence: 2,
    });
    expect(() => services.runs.append(opened.lease.token, request([assistant]))).toThrow(
      "request.conflict",
    );
    services.runs.append(opened.lease.token, request([lifecycle("started", 2)]));
    expect(() =>
      services.runs.append(opened.lease.token, request([lifecycle("started", 3, "twice")])),
    ).toThrow("request.conflict");
    const studentMessage = CanonicalRunEventSchema.parse({
      ...assistant,
      eventType: "student-message",
      sequence: 3,
    });
    expect(() => services.runs.append(opened.lease.token, request([studentMessage]))).toThrow(
      "request.conflict",
    );
    expect(
      database.readOne("SELECT count(*) AS total FROM marea_run_events WHERE run_id = ?1", [
        opened.lease.runId,
      ]),
    ).toEqual({ total: 2n });
  });

  it.each([
    "marea_read_project",
    "marea_list_project",
    "marea_read_skill",
    "marea_search_project",
    "marea_glob_project",
  ])("records %s only inside an admitted startup", (name) => {
    const opened = services.runs.open(student, newRun("read-startup"));
    const read = CanonicalRunEventSchema.parse({
      eventType: "tool-started",
      callId: "read:1",
      messageId: STARTUP_MESSAGE_ID,
      name,
      target: "file",
      arguments: "{}",
      truncated: false,
      sequence: 2,
      eventId: "event:read",
      occurredAt: clock.now(),
    });
    expect(() => services.runs.append(opened.lease.token, request([read]))).toThrow(
      "request.conflict",
    );
    services.runs.append(opened.lease.token, request([lifecycle("started", 2)]));
    expect(() =>
      services.runs.append(
        opened.lease.token,
        request([CanonicalRunEventSchema.parse({ ...read, name: "write_file", sequence: 3 })]),
      ),
    ).toThrow("request.conflict");
    const finish = CanonicalRunEventSchema.parse({
      eventType: "tool-finished",
      callId: "read:1",
      messageId: STARTUP_MESSAGE_ID,
      result: "Skill",
      failed: false,
      truncated: false,
      sequence: 4,
      eventId: "event:result",
      occurredAt: clock.now(),
    });
    expect(
      services.runs.append(
        opened.lease.token,
        request([{ ...read, sequence: 3 }, finish, lifecycle("completed", 5)]),
      ).highestDurableSequence,
    ).toBe(5);
    expect(() =>
      services.runs.append(
        opened.lease.token,
        request([{ ...finish, sequence: 6, eventId: "event:late" as typeof finish.eventId }]),
      ),
    ).toThrow("request.conflict");
  });

  it("does not treat ordinary correlated messages as the reserved startup turn", () => {
    const opened = services.runs.open(student, newRun("ordinary"));
    const events = ["student-message", "assistant-message"].map((eventType, index) =>
      CanonicalRunEventSchema.parse({
        eventType,
        messageId: "message:ordinary",
        content: "Ordinary message.",
        eventId: `event:ordinary:${String(index)}`,
        occurredAt: clock.now(),
        sequence: index + 2,
      }),
    );
    expect(services.runs.append(opened.lease.token, request(events)).highestDurableSequence).toBe(
      3,
    );
    expect(loadRunStartup(database, opened.lease.runId, opened.snapshot)).toBe("pending");
  });

  it("rejects free/legacy startup, missing runs and corrupted stored event metadata", async () => {
    const opened = services.runs.open(student, newRun("corrupt"));
    expect(
      loadRunStartup(database, opened.lease.runId, { ...opened.snapshot, agentMode: "free" }),
    ).toBeUndefined();
    const { startup, ...legacy } = opened.snapshot;
    expect(startup).toBeDefined();
    expect(loadRunStartup(database, opened.lease.runId, legacy)).toBeUndefined();
    expect(() => {
      validateStartupEvent(database, "run:missing", lifecycle("started", 2));
    }).toThrow("run.unavailable");
    const current = services.teaching.load(teacher, "class:one");
    await services.teaching.save(teacher, {
      ...teachingInput("free"),
      expectedVersion: current?.content.configurationVersion ?? null,
    });
    const free = services.runs.open(student, newRun("free"));
    expect(free).not.toHaveProperty("startupState");
    expect(free.snapshot).not.toHaveProperty("startup");
    expect(() =>
      services.runs.append(free.lease.token, request([lifecycle("started", 2)])),
    ).toThrow("request.conflict");
    const invalid = CanonicalRunEventSchema.parse({
      eventType: "run-activated",
      eventId: "event:bad",
      occurredAt: clock.now(),
      sequence: 2,
    });
    database.execute(
      "INSERT INTO marea_run_events (event_id, run_id, sequence, occurred_at, event_type, payload_json) VALUES ('event:bad', ?1, 2, ?2, 'tutor-startup', ?3)",
      [opened.lease.runId, clock.now(), JSON.stringify(invalid)],
    );
    expect(() => loadRunStartup(database, opened.lease.runId, opened.snapshot)).toThrow(
      "run.unavailable",
    );
  });
});
