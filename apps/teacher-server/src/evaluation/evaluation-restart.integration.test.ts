import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { EvaluationQuerySchema } from "@marea/protocol";

import {
  evaluationFixture,
  EVALUATION_DRAFT,
  evaluationRequest,
  reviewRequest,
  NOW,
  teacher,
} from "../../test-support/evaluation-fixture.js";
import { NodeSqliteTestDatabase } from "../../test-support/node-sqlite-database.boundary.js";
import { SYNTHETIC_ROUTE_BUDGET } from "../../test-support/usage-fixture.js";
import { SqliteEvaluationRepository } from "../platform/persistence/sqlite-evaluation-repository.js";
import { SqliteNoticeRepository } from "../platform/persistence/sqlite-notice-repository.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { createEvaluationModule } from "./evaluation-module.js";

describe("evaluation host durable recovery", () => {
  it("settles abandoned usage conservatively, retains queued work and approvals across database restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-evaluation-restart-"));
    const path = join(root, "teacher.sqlite");
    const original = evaluationFixture(path);
    original.queue();
    const abandoned = original.repository.claim("worker:abandoned", NOW);
    const account = { runId: "run:b", purpose: "evaluation" as const };
    const originalLedger = new SqliteUsageLedger(original.database);
    originalLedger.configure(account, SYNTHETIC_ROUTE_BUDGET.evaluation, NOW);
    originalLedger.reserve({
      ...account,
      requestId: "evaluation:1",
      reservationId: "reservation:abandoned",
      attempt: 1,
      now: NOW,
    });
    original.database.close();
    let database = new NodeSqliteTestDatabase(path);
    let id = 0;
    const calls = vi.fn();
    const onError = vi.fn();
    const host = () =>
      createEvaluationModule({
        repository: new SqliteEvaluationRepository(database),
        ledger: new SqliteUsageLedger(database),
        clock: { now: () => NOW },
        ids: { createId: () => `event:restart:${String(++id)}` },
        createReservationId: () => `reservation:restart:${String(++id)}`,
        intervalMs: 5,
        onError,
        providers: {
          resolve: () => ({
            async *stream(request) {
              calls(request);
              await Promise.resolve();
              yield { type: "text-delta", text: JSON.stringify(EVALUATION_DRAFT) };
              yield { type: "usage", inputTokens: 10, outputTokens: 20 };
              yield { type: "completed", finishReason: "stop" };
            },
          }),
        },
      });
    let module = host();
    const query = EvaluationQuerySchema.parse({
      protocolVersion: "0.1" as const,
      kind: "evaluation-query" as const,
      requestId: "request:query",
      runId: "run:b",
    });
    try {
      module.recoverAfterExclusiveStartup();
      expect(module.service.query(teacher, query).evaluation).toMatchObject({
        state: "failed",
        failure: "interrupted",
      });
      expect(new SqliteUsageLedger(database).totals(account)).toEqual({
        requests: 1,
        tokens: 81_920,
        costUnits: 180_224,
        inFlight: 0,
      });
      if (abandoned === null) throw new Error("Expected abandoned evaluation claim");
      expect(() => {
        new SqliteEvaluationRepository(database).finish(abandoned, EVALUATION_DRAFT, NOW);
      }).toThrow();
      const queued = module.service.generate(
        teacher,
        evaluationRequest("evaluation:1", "generate:restart"),
      ).evaluation;
      expect(queued).toMatchObject({ state: "queued", generation: 2 });
      await module.stop();
      database.close();
      database = new NodeSqliteTestDatabase(path);
      module = host();
      module.recoverAfterExclusiveStartup();
      expect(module.service.query(teacher, query).evaluation).toEqual(queued);
      module.start();
      module.start();
      expect(() => {
        module.recoverAfterExclusiveStartup();
      }).toThrow("Recovery must precede evaluation startup.");
      await vi.waitFor(() => {
        expect(module.service.query(teacher, query).evaluation?.state).toBe("draft");
      });
      await module.stop();
      expect(calls).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      const draft = module.service.query(teacher, query).evaluation;
      if (draft === null) throw new Error("Expected stored draft");
      const review = reviewRequest(draft.evaluationId);
      const approved = module.service.approve(teacher, review).evaluation;
      database.close();
      database = new NodeSqliteTestDatabase(path);
      module = host();
      module.recoverAfterExclusiveStartup();
      expect(module.service.query(teacher, query).evaluation).toEqual(approved);
      expect(module.service.approve(teacher, review).evaluation).toEqual(approved);
      expect(new SqliteNoticeRepository(database).pending("s1", 32)).toMatchObject([
        { source: "approved-evaluation", text: EVALUATION_DRAFT.studentFeedback },
      ]);
      expect(database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
      expect(new SqliteUsageLedger(database).totals(account)).toEqual({
        requests: 2,
        tokens: 81_950,
        costUnits: 180_304,
        inFlight: 0,
      });
    } finally {
      await module.stop();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
