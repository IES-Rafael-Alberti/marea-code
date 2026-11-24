import { RUN_CLOSED_REASON_HEADER } from "@marea/protocol";
import { createRunClosureMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operations/retention/retention-bun-sqlite.fixture.js"));

import { request } from "../../product-http/product-http.fixture.js";
import { NOW, composedHost, login, seededDatabase } from "./teacher-services.fixture.js";

const ORIGIN = { origin: "https://dashboard.test" };

async function openedRun() {
  const database = seededDatabase();
  // The closing actor column belongs to the newest schema; apply every migration after eight.
  for (const migration of createRunClosureMigrationCatalog().slice(8))
    for (const sql of migration.statements) database.executeScript(sql);
  const host = await composedHost(database);
  const student = await host.call("/v1/auth/login", login("student", "student-password"));
  const token = (student.body.session as { token: string }).token;
  const open = async (key: string, runId?: string) =>
    host.call(
      "/v1/runs/open",
      {
        clientSessionId: "client:one",
        clientVersion: "0.2.0",
        idempotencyKey: key,
        intent: { kind: runId === undefined ? "new" : "resume" },
        project: { displayName: "Wave lab" },
        protocolVersion: "0.1",
        requestId: `request:${key}`,
        ...(runId === undefined ? {} : { runId }),
      },
      token,
    );
  const opened = await open("open:one");
  const lease = opened.body.lease as { token: string; runId: string };
  const teacher = await host.app.fetch(
    request("/v1/auth/login", login("teacher", "teacher-password")),
  );
  const cookie = String(teacher.headers.get("set-cookie")).split(";")[0] ?? "";
  const dashboard = (path: string, body: object) =>
    host.app.fetch(request(path, body, undefined, { cookie, ...ORIGIN }));
  const state = () =>
    host.database.readOne("SELECT state, close_reason, closed_by FROM marea_runs WHERE id = ?1", [
      lease.runId,
    ]);
  return { host, token, lease, open, dashboard, state, cookie };
}

describe("composed run closure", () => {
  it("lets a teacher end a student run and tells the student why, then starts a new run", async () => {
    const { host, token, lease, open, dashboard, state, cookie } = await openedRun();
    const closed = await dashboard("/api/v1/dashboard/runs/close", {
      idempotencyKey: "close:one",
      kind: "teacher-run-close",
      protocolVersion: "0.1",
      requestId: "request:teacher-close",
      runId: lease.runId,
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ closed: [lease.runId], unchanged: [] });
    expect(state()).toEqual({ state: "closed", close_reason: "teacher-ended", closed_by: "t1" });

    const presence = await host.app.fetch(
      request("/v1/runs/presence", { requestId: "request:presence" }, lease.token),
    );
    expect(presence.status).toBe(409);
    expect(presence.headers.get(RUN_CLOSED_REASON_HEADER)).toBe("teacher-ended");
    const resume = await host.app.fetch(
      request(
        "/v1/runs/open",
        {
          clientSessionId: "client:one",
          clientVersion: "0.2.0",
          idempotencyKey: "open:resume",
          intent: { kind: "resume" },
          project: { displayName: "Wave lab" },
          protocolVersion: "0.1",
          requestId: "request:resume",
          runId: lease.runId,
        },
        token,
      ),
    );
    expect(resume.status).toBe(409);
    expect(resume.headers.get(RUN_CLOSED_REASON_HEADER)).toBe("teacher-ended");
    // Leaving a closed session is still a clean exit for the student.
    const exit = await host.call(
      "/v1/runs/close",
      {
        protocolVersion: "0.1",
        reason: "student-exit",
        requestId: "request:exit",
        runId: lease.runId,
      },
      token,
    );
    expect(exit).toMatchObject({ status: 200, body: { alreadyClosed: true } });
    const fresh = await open("open:two");
    expect(fresh.status).toBe(201);
    expect((fresh.body.lease as { runId: string }).runId).not.toBe(lease.runId);
    const listed = await host.app.fetch(
      new Request(
        "http://teacher.test/api/v1/dashboard/active-runs?kind=active-runs-query&protocolVersion=0.1&requestId=request%3Alist&limit=50",
        { headers: { cookie, host: "teacher.test" } },
      ),
    );
    expect(await listed.json()).toMatchObject({
      runs: [{ runId: (fresh.body.lease as { runId: string }).runId, classId: "class:one" }],
    });
  });

  it("ends the listed runs of a class as class-ended", async () => {
    const { lease, dashboard, state } = await openedRun();
    const closed = await dashboard("/api/v1/dashboard/classes/close-runs", {
      classId: "class:one",
      idempotencyKey: "close:class",
      kind: "class-runs-close",
      protocolVersion: "0.1",
      requestId: "request:class-close",
      runIds: [lease.runId],
    });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ closed: [lease.runId] });
    expect(state()).toEqual({ state: "closed", close_reason: "class-ended", closed_by: "t1" });
  });

  it("closes an abandoned run once at exclusive startup, as session-expired", async () => {
    const { host, lease, state } = await openedRun();
    host.database.execute("UPDATE marea_active_runs SET last_activity_at = ?1", [
      "2026-09-14T08:59:00.000Z",
    ]);
    host.database.execute("UPDATE marea_run_leases SET expires_at = ?1", [NOW]);
    expect(state()).toMatchObject({ state: "active" });
    host.composed.evaluations.recoverAfterExclusiveStartup();
    expect(state()).toEqual({ state: "closed", close_reason: "session-expired", closed_by: null });
    const refused = await host.app.fetch(
      request("/v1/runs/presence", { requestId: "request:presence" }, lease.token),
    );
    expect(refused.headers.get(RUN_CLOSED_REASON_HEADER)).toBe("session-expired");
  });
});
