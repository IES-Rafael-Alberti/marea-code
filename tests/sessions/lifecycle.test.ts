import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AppendRunEventsRequestSchema,
  EventIdSchema,
  OpenRunRequestSchema,
} from "../../packages/protocol/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import {
  AcceptanceAgent,
  AcceptanceInterface,
  AcceptanceResources,
  enroll,
  openRun,
  syntheticStudent,
} from "../../test-support/acceptance/resources.js";
import {
  ACCEPTANCE_CLIENT_VERSION,
  ACCEPTANCE_PROJECT,
  createRealStudentApplication,
} from "../../test-support/acceptance/harness.js";

const resources = new AcceptanceResources();

afterEach(async () => resources.close());

describe("acceptance journeys over HTTP and SQLite", () => {
  it("launches, authenticates, sends, approves a real DeepAgents write, and resumes context", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-real-");
    const firstInterface = new AcceptanceInterface();
    const first = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface: firstInterface,
      }),
    );

    const opened = await first.controller.start(ACCEPTANCE_PROJECT);
    await first.controller.sendMessage(
      "message:first",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );

    expect(firstInterface.prompts).toHaveLength(1);
    await expect(readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).resolves.toBe(
      "The tide is rising.\n",
    );
    expect(firstInterface.authenticationReasons).toEqual(["missing"]);
    expect(value.provider.requests[0]?.messages.at(-1)).toEqual({
      content: "Please prepare the tide notes.",
      role: "user",
    });
    expect(value.provider.requests[0]?.tools.map((tool) => tool.name)).toContain("write_file");
    expect(value.provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain(
      "marea_write_file",
    );
    expect(
      value.database.readAll("SELECT event_type FROM marea_run_events ORDER BY sequence"),
    ).toEqual([
      { event_type: "run-activated" },
      { event_type: "student-message" },
      { event_type: "approval-requested" },
      { event_type: "approval-resolved" },
      { event_type: "workspace-edit" },
      { event_type: "tool-started" },
      { event_type: "tool-finished" },
      { event_type: "assistant-message" },
      { event_type: "turn-ended" },
    ]);

    first.dispose();
    const second = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface: new AcceptanceInterface(),
      }),
    );
    const resumed = await second.controller.start(ACCEPTANCE_PROJECT);
    await second.controller.sendMessage(
      "message:second",
      "What did we save?",
      new AbortController().signal,
    );

    expect(resumed.runId).toBe(opened.runId);
    expect(value.provider.requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        { content: "Please prepare the tide notes.", role: "user" },
        expect.objectContaining({ role: "tool" }),
        { content: "What did we save?", role: "user" },
      ]),
    );
    const publicConversation = JSON.stringify(
      value.provider.requests.map((request) => ({
        messages: request.messages,
        tools: request.tools,
      })),
    );
    expect(publicConversation).toContain('"name":"write_file"');
    expect(publicConversation).not.toContain("marea_write_file");
    expect(value.database.readAll("SELECT event_type FROM marea_run_events")).toHaveLength(12);
  });

  it("retries a disconnected open with durable identity, then reconnects to the same run", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-open-");
    const agent = new AcceptanceAgent();
    const first = await syntheticStudent(value, location, agent);
    value.http.loseNextResponse({ path: "/v1/runs/open" });

    await expect(first.start(ACCEPTANCE_PROJECT)).rejects.toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    const second = await syntheticStudent(value, location, agent);
    const resumed = await second.start(ACCEPTANCE_PROJECT);
    const state = parseStudentState(
      JSON.parse(await readFile(join(location.stateDirectory, "session.json"), "utf8")),
    );

    expect(state.run?.phase).toBe("active");
    expect(resumed.runId).toBe(value.database.readAll("SELECT id FROM marea_runs")[0]?.id);
    expect(agent.messageCalls).toBe(0);
  });

  it("rejects an expired lease, then permits authenticated continuation with a rotated lease", async () => {
    const value = await resources.harness();
    const ada = await enroll(value, "ada");
    const opened = await openRun(value, ada.session.token, "lease");
    const event = AppendRunEventsRequestSchema.parse({
      events: [
        {
          content: "late",
          eventId: EventIdSchema.parse("event:late"),
          eventType: "student-message",
          occurredAt: value.clock.now(),
          sequence: 2,
        },
      ],
      kind: "run-events-append",
      protocolVersion: "0.1",
      requestId: "request:late",
    });
    value.clock.advance(10 * 60 * 1_000 + 1);

    await expect(
      value.studentServer.appendRunEvents(opened.lease.token, event),
    ).rejects.toMatchObject({
      code: "run.unavailable",
    });
    const continued = await value.studentServer.openRun(
      ada.session.token,
      OpenRunRequestSchema.parse({
        clientSessionId: "client:lease-continuation",
        clientVersion: ACCEPTANCE_CLIENT_VERSION,
        idempotencyKey: "open:lease-continuation",
        intent: { kind: "resume" },
        project: { displayName: "project-lease" },
        protocolVersion: "0.1",
        requestId: "request:lease-continuation",
      }),
    );

    expect(continued.lease.runId).toBe(opened.lease.runId);
    expect(continued.lease.token).not.toBe(opened.lease.token);
    await expect(
      value.studentServer.appendRunEvents(continued.lease.token, event),
    ).resolves.toMatchObject({
      highestDurableSequence: 2,
    });
  });

  it("persists an offline exit past lease expiry and closes it after process restart", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-close-");
    const agent = new AcceptanceAgent();
    const first = await syntheticStudent(value, location, agent);
    const opened = await first.start(ACCEPTANCE_PROJECT);

    await value.http.stop();
    value.clock.advance(10 * 60 * 1_000 + 1);
    await expect(first.close()).rejects.toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    expect(
      parseStudentState(
        JSON.parse(await readFile(join(location.stateDirectory, "session.json"), "utf8")),
      ).run,
    ).toMatchObject({
      closeReason: "student-exit",
      phase: "closing",
      runId: opened.runId,
    });

    await value.http.start();
    const second = await syntheticStudent(value, location, agent);
    const next = await second.start(ACCEPTANCE_PROJECT);

    expect(next.runId).not.toBe(opened.runId);
    expect(value.database.readAll("SELECT state FROM marea_runs ORDER BY opened_at, id")).toEqual([
      { state: "closed" },
      { state: "active" },
    ]);
  });
});
