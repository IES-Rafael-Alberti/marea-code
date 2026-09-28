import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InferenceProvider } from "@marea/plugin-api";
import { ModelGatewayRequestSchema, ModelGatewayStreamChunkSchema } from "@marea/protocol";
import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { BudgetedInferenceProvider } from "../src/model-gateway/budgeted-provider.boundary.js";
import type { InferenceDiagnostic } from "../src/model-gateway/inference-failure.boundary.js";
import { ModelGatewayService } from "../src/model-gateway/model-gateway-service.js";
import { SqliteUsageLedger } from "../src/platform/persistence/sqlite-usage-ledger.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import { modelStreamResponse } from "../src/product-http/model-stream.js";
import { USAGE_POLICY } from "../test-support/usage-fixture.js";
import { compileExecutable } from "./compile-executable.js";

async function exercise(root: string): Promise<void> {
  const storage = initializeSqliteStorage({ databasePath: join(root, "synthetic.sqlite") });
  const db = storage.database;
  const clock = { now: () => new Date().toISOString() };
  db.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:test', 'test', 'Synthetic')",
  );
  db.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('student:test', 'test', 'synthetic', 'student', 'Synthetic', 'class:test')",
  );
  db.execute(
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES ('snapshot:test', '{}', '{}', ?1)",
    [clock.now()],
  );
  const ledger = new SqliteUsageLedger(db);
  const diagnostics: InferenceDiagnostic[] = [];
  let reservation = 0;
  let calls = 0;
  const server = bunServe({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (incoming) => {
      const request = ModelGatewayRequestSchema.parse(await incoming.json());
      const slow = request.requestId === "request:slow";
      const account = { runId: slow ? "run:slow" : "run:deadline", purpose: "tutoring" as const };
      const provider: InferenceProvider = {
        async *stream() {
          calls += 1;
          yield { type: "text-delta", text: "Prefix " };
          await Bun.sleep(slow ? 61_000 : 80);
          yield { type: "text-delta", text: "finished" };
          yield { type: "usage", inputTokens: 2, outputTokens: 3 };
          yield { type: "completed", finishReason: "stop" };
        },
      };
      const metered = new BudgetedInferenceProvider({
        account,
        ledger,
        provider,
        clock,
        createReservationId: () => `attempt:${String(++reservation)}`,
        requestId: request.requestId,
        providerInputTokenCeiling: 10,
        diagnostic: (event) => diagnostics.push(event),
      });
      const gateway = new ModelGatewayService({
        clock,
        route: { provider: metered, upstreamModel: "synthetic" },
        retry: {
          wait: () => {
            throw new Error("Unexpected automatic retry");
          },
        },
      });
      return modelStreamResponse(gateway, request, incoming.signal);
    },
  });
  try {
    for (const [id, duration] of [
      ["slow", 300_000],
      ["deadline", 30],
    ] as const) {
      const account = { runId: `run:${id}`, purpose: "tutoring" as const };
      db.execute(
        "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at) VALUES (?1, 'student:test', 'class:test', 'snapshot:test', ?2, 'Synthetic', 'active', ?3)",
        [account.runId, `client:${id}`, clock.now()],
      );
      ledger.configure(
        account,
        { ...USAGE_POLICY, maxRequestDurationMs: duration, maxRequests: 1 },
        clock.now(),
      );
      const request = {
        kind: "model-gateway-request",
        protocolVersion: "0.1",
        requestId: `request:${id}`,
        modelAlias: "marea",
        messages: [{ role: "student", content: "Synthetic request" }],
        tools: [],
      };
      const read = async () => {
        const response = await fetch(`${server.url}/model`, {
          method: "POST",
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(75_000),
        });
        assert.equal(response.status, 200);
        return (await response.text())
          .trim()
          .split("\n")
          .map((line) => ModelGatewayStreamChunkSchema.parse(JSON.parse(line)));
      };
      const chunks = await read();
      assert.equal(chunks[0]?.event, "started");
      assert.equal(chunks[1]?.event, "text-delta");
      if (id === "slow") {
        assert.equal(chunks.at(-1)?.event, "completed");
        assert.equal(ledger.totals(account).tokens, 5);
        assert.ok((diagnostics.at(-1)?.durationMs ?? 0) >= 60_000);
      } else {
        assert.deepEqual(chunks.at(-1), {
          ...chunks.at(-1),
          event: "failed",
          code: "deadline-exceeded",
          retryable: false,
        });
        assert.equal(ledger.totals(account).tokens, 20);
        const refused = await read();
        assert.equal(refused.at(-1)?.event, "failed");
        assert.deepEqual(refused.at(-1), {
          ...refused.at(-1),
          code: "budget-exhausted",
          retryable: false,
        });
      }
      assert.equal(ledger.totals(account).inFlight, 0);
    }
    assert.equal(calls, 2);
    assert.equal(diagnostics[0]?.limitMs, 300_000);
    assert.equal(diagnostics[1]?.settlement, "unknown");
    assert.equal(diagnostics[2]?.settlement, "not-admitted");
  } finally {
    await server.stop();
    storage.close();
  }
}

const root = mkdtempSync(join(tmpdir(), "marea-inference-recovery-"));
try {
  if (process.argv.includes("--compiled")) {
    await exercise(root);
    process.stdout.write(
      "Compiled inference recovery: pass (synthetic, 61 seconds, SQLite, HTTP)\n",
    );
  } else {
    const executable = join(root, "probe");
    compileExecutable("smoke/compiled-inference-recovery.ts", executable);
    const result = spawnSync(executable, ["--compiled"], { encoding: "utf8", timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    process.stdout.write(result.stdout);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
