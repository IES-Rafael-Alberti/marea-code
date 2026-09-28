import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTranslator } from "../../packages/i18n/src/index.js";
import { describe, expect, it, vi } from "vitest";

import { createEvaluationClient } from "../../apps/dashboard/src/modules/evaluation/evaluation-client.boundary.js";
import { EvaluationController } from "../../apps/dashboard/src/modules/evaluation/evaluation-controller.js";
import { createFileStudentStores } from "../../apps/student/src/filesystem.boundary.js";
import { createHttpStudentHistory } from "../../apps/student/src/http-history.boundary.js";
import {
  createStudentStateDirectory,
  executeMareaCommand,
} from "../../apps/student/src/marea-command.boundary.js";
import { SqliteUsageLedger } from "../../apps/teacher-server/src/platform/persistence/sqlite-usage-ledger.js";
import {
  AppendRunEventsRequestSchema,
  CloseRunRequestSchema,
  CredentialLoginRequestSchema,
  OpenRunRequestSchema,
  PendingNoticesRequestSchema,
} from "../../packages/protocol/src/index.js";
import { enrollAcceptanceStudent } from "../../test-support/acceptance/harness.js";
import {
  ACCEPTANCE_EVALUATION,
  evaluationAcceptanceHarness,
} from "../../test-support/evaluation/harness.js";

describe("complete evaluation journey", () => {
  it("closes asynchronously, reviews frozen evidence, sends exactly once after a lost response, and receives feedback in the student CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-evaluation-acceptance-"));
    const harness = await evaluationAcceptanceHarness();
    try {
      const student = await enrollAcceptanceStudent(harness, "ada");
      const opened = await harness.studentServer.openRun(
        student.session.token,
        OpenRunRequestSchema.parse({
          protocolVersion: "0.1",
          clientVersion: "0.2.0",
          requestId: "request:open",
          idempotencyKey: "open:evaluation",
          clientSessionId: "client:evaluation",
          intent: { kind: "new" },
          project: { displayName: "Evaluation exercise" },
        }),
      );
      const runId = opened.lease.runId;
      const evaluationEvents = [
        {
          eventType: "student-message",
          messageId: "message:one",
          eventId: "event:student",
          sequence: 2,
          occurredAt: harness.clock.now(),
          content: "We should test an empty input.",
        },
        {
          eventType: "assistant-message",
          messageId: "message:one",
          eventId: "event:assistant",
          sequence: 3,
          occurredAt: harness.clock.now(),
          content: "Explain what should happen.",
        },
      ];
      await harness.studentServer.appendRunEvents(
        opened.lease.token,
        AppendRunEventsRequestSchema.parse({
          kind: "run-events-append",
          protocolVersion: "0.1",
          requestId: "request:append",
          events: evaluationEvents,
        }),
      );
      await harness.studentServer.closeRunAuthenticated(
        student.session.token,
        CloseRunRequestSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:close",
          runId,
          reason: "student-exit",
        }),
      );
      await harness.provider.entered.promise;
      expect(harness.provider.requests).toHaveLength(1);
      const teacher = await harness.studentServer.login(
        CredentialLoginRequestSchema.parse({
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:teacher",
          credentials: { login: "grace.teacher", password: "teacher-password" },
        }),
      );
      let request = 0;
      const client = createEvaluationClient(
        (path, init) => {
          const headers = new Headers(init.headers);
          headers.set("cookie", `marea_teacher_session=${teacher.session.token}`);
          headers.set("origin", "http://127.0.0.1");
          return fetch(`${harness.http.baseUrl}${path}`, { ...init, headers });
        },
        () => `request:review:${String(++request)}`,
      );
      const signal = new AbortController().signal;
      expect((await client.query(runId, signal)).evaluation?.state).toBe("running");
      const reader = createHttpStudentHistory({ baseUrl: harness.http.baseUrl });
      const pending = PendingNoticesRequestSchema.parse({
        kind: "pending-notices-query",
        protocolVersion: "0.1",
        requestId: "request:pending",
        limit: 32,
      });
      expect((await reader.pendingNotices(student.session.token, pending)).notices).toEqual([]);
      harness.provider.gate.resolve(undefined);
      await vi.waitFor(async () => {
        expect((await client.query(runId, signal)).evaluation?.state).toBe("draft");
      });
      const controller = new EvaluationController(
        client,
        () => undefined,
        () => `action:${String(++request)}`,
      );
      await controller.loadSessions();
      expect(controller.state.sessions?.runs).toMatchObject([
        { runId, state: "closed", studentDisplayName: "Student Ada" },
      ]);
      await controller.select(runId);
      expect(controller.state.history?.events.map((event) => event.eventType)).toEqual([
        "run-activated",
        "student-message",
        "assistant-message",
        "run-closed",
      ]);
      expect(controller.state.draft).toEqual(ACCEPTANCE_EVALUATION);
      const first = controller.state.evaluation;
      expect(first).toMatchObject({ state: "draft", generation: 1 });
      expect(harness.provider.requests[0]?.tools).toEqual([]);
      expect(harness.provider.requests[0]?.messages[1]?.content).toContain(
        "Synthetic evaluation instructions",
      );
      expect(harness.provider.requests[0]?.messages[1]?.content).toContain(
        "We should test an empty input.",
      );
      expect(harness.provider.requests[0]?.messages[1]?.content).not.toContain("providerRoute");
      expect((await reader.pendingNotices(student.session.token, pending)).notices).toEqual([]);
      const reviewed = {
        ...ACCEPTANCE_EVALUATION,
        studentFeedback: "Teacher-reviewed: explain one empty-input test.",
        teacherNote: "Private edited note.",
      };
      controller.edit(reviewed);
      harness.http.loseNextResponse({ path: "/api/v1/dashboard/evaluations/approve" });
      await controller.approve();
      expect(controller.state).toMatchObject({ error: true, uncertain: true });
      await controller.approve();
      expect(controller.state.evaluation?.state).toBe("approved");
      const notices = (await reader.pendingNotices(student.session.token, pending)).notices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        text: reviewed.studentFeedback,
        source: "approved-evaluation",
      });
      expect(JSON.stringify(notices)).not.toContain("Private");
      const projectRoot = join(root, "project");
      await mkdir(projectRoot);
      const stateRoot = join(root, "state");
      const stores = await createFileStudentStores({
        projectRoot,
        stateDirectory: createStudentStateDirectory(stateRoot, harness.http.baseUrl, projectRoot),
      });
      await stores.credentials.save(student.session.token);
      const output = { write: vi.fn(), error: vi.fn() };
      const options = {
        arguments: ["feedback"],
        currentDirectory: projectRoot,
        homeDirectory: root,
        stateRoot,
        serverUrl: harness.http.baseUrl,
        translator: createTranslator("en"),
        output,
      };
      expect(await executeMareaCommand(options)).toBe(0);
      expect(output.write).toHaveBeenCalledWith(expect.stringContaining(reviewed.studentFeedback));
      expect(JSON.stringify(output.write.mock.calls)).not.toContain("Private");
      expect((await reader.pendingNotices(student.session.token, pending)).notices).toEqual(
        notices,
      );
      const noticeId = notices[0]?.noticeId;
      if (noticeId === undefined) throw new Error("Expected approved feedback notice");
      harness.http.loseNextResponse({ path: "/v1/notices/acknowledge" });
      const acknowledge = { ...options, arguments: ["feedback", "--ack", noticeId] };
      expect(await executeMareaCommand(acknowledge)).toBe(1);
      expect(await executeMareaCommand(acknowledge)).toBe(0);
      expect((await reader.pendingNotices(student.session.token, pending)).notices).toEqual([]);
      await controller.generate();
      await vi.waitFor(async () => {
        await controller.refresh();
        expect(controller.state.evaluation?.state).toBe("draft");
      });
      expect(controller.state.evaluation).toMatchObject({
        generation: 2,
        inputDigest: first?.inputDigest,
      });
      expect(controller.state.evaluation?.evaluationId).not.toBe(first?.evaluationId);
      expect((await reader.pendingNotices(student.session.token, pending)).notices).toEqual([]);
      expect(harness.provider.requests).toHaveLength(2);
      expect(harness.provider.requests[1]?.messages).toEqual(
        harness.provider.requests[0]?.messages,
      );
      expect(harness.database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
      expect(harness.database.readAll("SELECT id FROM marea_runs")).toHaveLength(1);
      const usage = new SqliteUsageLedger(harness.database);
      expect(usage.totals({ runId, purpose: "evaluation" })).toEqual({
        requests: 2,
        tokens: 300,
        costUnits: 700,
        inFlight: 0,
      });
      expect(usage.totals({ runId, purpose: "tutoring" }).requests).toBe(0);
      expect(harness.evaluationErrors).toEqual([]);
      controller.dispose();
    } finally {
      harness.provider.gate.resolve(undefined);
      await harness.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
