import { SqliteUsageLedger } from "../persistence/sqlite-usage-ledger.js";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { CredentialLoginResponseSchema, TelemetryPreviewResponseSchema } from "@marea/protocol";
import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import {
  cleanupTeacherHostInstallations,
  teacherHostInstallation,
} from "../teacher-host/teacher-host.fixture.js";
import { startTeacherHost } from "../teacher-host/teacher-host.js";
import { previewHttpRequest, previewRequest } from "../../telemetry/preview.fixture.js";
import { openRequest, request } from "../../product-http/product-http.fixture.js";
import { runtimeFixture } from "./runtime.fixture.js";

afterEach(cleanupTeacherHostInstallations);
const passwords = {
  hash: (value: string) => Promise.resolve(`hash:${value}`),
  verify: (value: string, digest: string) => Promise.resolve(digest === `hash:${value}`),
};
function installation() {
  const f = teacherHostInstallation({ readyClasses: ["class:one"] });
  const opened = openSqliteDatabaseFile({ databasePath: f.databasePath });
  const db = opened.database;
  db.execute(
    "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:one', 'one', 'Synthetic class')",
  );
  db.execute("INSERT INTO marea_teacher_classes VALUES ('user:teacher', 'class:one')");
  db.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('synthetic-student', 'student', 'hash:student-password', 'student', 'Synthetic learner', 'class:one')",
  );
  new SqliteTeachingConfigurationRepository(db).saveRevision({
    classId: "class:one",
    teacherId: "user:teacher",
    createdAt: "2026-09-22T00:00:00.000Z",
    expectedVersion: null,
    configuration: teachingConfiguration("free"),
  });
  opened.close();
  return f;
}
function login(login: string) {
  return request("/v1/auth/login", {
    credentials: { login, password: `${login}-password` },
    kind: "credential-login",
    protocolVersion: "0.1",
    requestId: "request:login",
  });
}
it.each(["collector", "failed", "timeout", "missing-secret"])(
  "uses one host runtime for preview, successful runs and shutdown with %s",
  async (mode) => {
    const f = installation();
    const telemetry = runtimeFixture();
    telemetry.configuration.exporters.forEach((entry) => {
      entry.operationTimeoutMs = 100;
    });
    f.writeHost({ ...f.host, telemetry: telemetry.configuration });
    const received: string[] = [];
    const collector = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push(body);
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (address === null || typeof address === "string") throw new Error("Missing local collector");
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    const shutdown = vi.fn(() => Promise.resolve());
    telemetry.createOtlp.mockReturnValue({
      id: "synthetic-private-id",
      export: async (envelope, signal) => {
        if (mode === "failed") throw new Error("synthetic-secret");
        if (mode === "timeout")
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
        else await fetch(endpoint, { method: "POST", body: JSON.stringify(envelope), signal });
      },
      shutdown,
    });
    if (mode === "missing-secret")
      telemetry.resolve.mockRejectedValueOnce(new Error("synthetic-secret"));
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      passwords,
      telemetry,
      onEvaluationError: () => undefined,
    });
    if (host.state !== "ready") throw new Error(host.reason);
    try {
      // Collector delivery is a real HTTP assertion, independent of scheduling
      // load. The separate timeout case still exercises the configured deadline.
      if (mode === "collector")
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const dispatch = f.served.fetch;
      if (dispatch === undefined) throw new Error("Missing dispatcher");
      const teacher = await dispatch(login("teacher"));
      const cookie = String(teacher.headers.get("set-cookie")).split(";")[0] ?? "";
      const preview = await dispatch(previewHttpRequest(cookie));
      const body: unknown = await preview.json();
      expect(TelemetryPreviewResponseSchema.parse(body)).toMatchObject({
        enabled: true,
        destinationCount: mode === "missing-secret" ? 1 : 2,
        synthetic: true,
      });
      expect(received).toHaveLength(0);
      expect(
        (await dispatch(previewHttpRequest(cookie, { ...previewRequest, classId: "class:denied" })))
          .status,
      ).toBe(403);
      await dispatch(
        new Request("http://teacher.test/v1/runs/open", { headers: { host: "teacher.test" } }),
      );
      expect(telemetry.langfuse.exported).toHaveLength(0);
      const student = CredentialLoginResponseSchema.parse(
        await (await dispatch(login("student"))).json(),
      );
      const run = await dispatch(request("/v1/runs/open", openRequest, student.session.token));
      expect(run.status).toBe(201);
      expect(telemetry.langfuse.exported).toHaveLength(1);
      expect(JSON.stringify(telemetry.langfuse.exported)).not.toMatch(
        /synthetic-student|class:one|Wave lab|client:one|request:open|synthetic-secret/,
      );
      expect(JSON.stringify(body) + readFileSync(f.host.statusPath, "utf8")).not.toMatch(
        /synthetic-secret|collector.invalid|langfuse.invalid/,
      );
      if (mode === "collector") expect(received).toHaveLength(1);
      else expect(received).toHaveLength(0);
      // Preview never touches exporter state, even after a delivery timeout.
      expect((await dispatch(previewHttpRequest(cookie))).status).toBe(200);
      expect(telemetry.resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await host.stop();
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    expect(shutdown).toHaveBeenCalledTimes(mode === "missing-secret" ? 0 : 1);
    expect(telemetry.langfuse.shutdownSignals).toHaveLength(1);
  },
);
it.each(["assets", "listen"])(
  "cleans constructed exporters after host %s startup failure",
  async (reason) => {
    const f = installation();
    const telemetry = runtimeFixture();
    f.writeHost({ ...f.host, telemetry: telemetry.configuration });
    if (reason === "assets") rmSync(`${f.host.dashboardDistPath}/index.html`);
    const host = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      passwords,
      telemetry,
      serve:
        reason === "listen"
          ? () => {
              throw new Error("synthetic-secret");
            }
          : f.serve,
      onEvaluationError: () => undefined,
    });
    expect(host).toEqual({ state: "failed", reason });
    expect(telemetry.otlp.shutdownSignals).toHaveLength(1);
    expect(telemetry.langfuse.shutdownSignals).toHaveLength(1);
  },
);
it("drains an admitted operation before shutting down its exporters", async () => {
  const f = installation();
  const telemetry = runtimeFixture();
  telemetry.configuration.exporters.forEach((entry) => {
    entry.operationTimeoutMs = 1000;
  });
  f.writeHost({ ...f.host, telemetry: telemetry.configuration });
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const order: string[] = [];
  telemetry.createOtlp.mockReturnValue({
    id: "synthetic-private",
    export: async () => {
      entered.resolve(undefined);
      await release.promise;
      order.push("export-finished");
    },
    shutdown: () => {
      order.push("shutdown");
      return Promise.resolve();
    },
  });
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords,
    telemetry,
    onEvaluationError: () => undefined,
  });
  if (host.state !== "ready" || f.served.fetch === undefined) throw new Error("Host unavailable");
  const pending = f.served.fetch(request("/v1/runs/open", openRequest));
  await entered.promise;
  const stopped = host.stop();
  await Promise.resolve();
  expect(order).toEqual([]);
  release.resolve(undefined);
  expect((await pending).status).toBe(401);
  expect(await stopped).toEqual({ state: "stopped", reasonCode: "stopped" });
  expect(order).toEqual(["export-finished", "shutdown"]);
  expect((await f.served.fetch(request("/v1/runs/open", openRequest))).status).toBe(503);
  expect(telemetry.langfuse.exported).toHaveLength(1);
});
it("propagates host startup cancellation into private resolution and partial cleanup", async () => {
  const f = installation();
  const telemetry = runtimeFixture();
  telemetry.configuration.startupTimeoutMs = 1000;
  f.writeHost({ ...f.host, telemetry: telemetry.configuration });
  const controller = new AbortController();
  const constructed = Promise.withResolvers<undefined>();
  const late = Promise.withResolvers<typeof telemetry.connections.otlp>();
  telemetry.resolve.mockImplementationOnce(() => late.promise);
  telemetry.createLangfuse.mockImplementation(() => {
    constructed.resolve(undefined);
    return telemetry.langfuse.port;
  });
  const pending = startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords,
    telemetry,
    startupSignal: controller.signal,
    onEvaluationError: () => undefined,
  });
  await constructed.promise;
  controller.abort();
  const host = await pending;
  if (host.state !== "ready") throw new Error(host.reason);
  try {
    expect(telemetry.langfuse.shutdownSignals).toHaveLength(1);
    late.resolve(telemetry.connections.otlp);
    await Promise.resolve();
    expect(telemetry.createOtlp).not.toHaveBeenCalled();
  } finally {
    await host.stop();
  }
});
it("retains the request drain budget for admitted operations without telemetry", async () => {
  const f = installation();
  const telemetry = runtimeFixture();
  f.writeHost({ ...f.host, telemetry: telemetry.configuration });
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<boolean>();
  const host = await startTeacherHost({
    telemetry,
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords: {
      ...passwords,
      verify: () => {
        entered.resolve(undefined);
        return release.promise;
      },
    },
    onEvaluationError: () => undefined,
  });
  if (host.state !== "ready" || f.served.fetch === undefined) throw new Error("Host unavailable");
  const pending = f.served.fetch(login("teacher"));
  await entered.promise;
  vi.useFakeTimers();
  let stopped = false;
  const stopping = host.stop().then((result) => {
    stopped = true;
    return result;
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);
    expect(telemetry.otlp.shutdownSignals).toHaveLength(0);
  } finally {
    release.resolve(true);
    expect((await pending).status).toBe(200);
    await stopping;
    expect(telemetry.otlp.shutdownSignals).toHaveLength(1);
    vi.useRealTimers();
  }
});

it("cleans exporters and releases ownership if evaluation recovery fails", async () => {
  const f = installation();
  const telemetry = runtimeFixture();
  f.writeHost({ ...f.host, telemetry: telemetry.configuration });
  const recovery = vi
    .spyOn(SqliteUsageLedger.prototype, "recoverUnfinished")
    .mockImplementationOnce(() => {
      throw new Error("synthetic-secret");
    });
  try {
    const result = await startTeacherHost({
      installationRoot: f.root,
      releaseId: "release:host",
      serve: f.serve,
      passwords,
      telemetry,
      onEvaluationError: () => undefined,
    });
    expectCleanConfigurationFailure(result, f, telemetry);
  } finally {
    recovery.mockRestore();
  }
});
it("terminates on service composition failure before inspecting dashboard assets", async () => {
  const f = installation();
  const telemetry = runtimeFixture();
  f.writeHost({ ...f.host, telemetry: telemetry.configuration });
  rmSync(`${f.host.dashboardDistPath}/index.html`);
  const result = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    serve: f.serve,
    passwords: { ...passwords, hash: () => Promise.reject(new Error("synthetic-secret")) },
    telemetry,
    onEvaluationError: () => undefined,
  });
  expectCleanConfigurationFailure(result, f, telemetry);
});

function expectCleanConfigurationFailure(
  result: Awaited<ReturnType<typeof startTeacherHost>>,
  installation: ReturnType<typeof teacherHostInstallation>,
  telemetry: ReturnType<typeof runtimeFixture>,
) {
  expect(result).toEqual({ state: "failed", reason: "config" });
  expect(telemetry.otlp.shutdownSignals).toHaveLength(1);
  expect(telemetry.langfuse.shutdownSignals).toHaveLength(1);
  expect(installation.served.fetch).toBeUndefined();
}
