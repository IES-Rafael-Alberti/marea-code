import { RunsCloseResponseSchema } from "@marea/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunClosedError } from "../identity/errors.js";
import { safeOperation } from "./domain-error.boundary.js";
import {
  createApplication,
  createServices,
  fetchJson,
  RecordingProvider,
  request,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";
import {
  unhandledErrorLog,
  writeUnhandledError,
  type UnhandledErrorRecord,
} from "./unhandled-error-log.boundary.js";

const headers = {
  cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
  origin: "https://dashboard.test",
};
const close = {
  protocolVersion: "0.1",
  requestId: "request:close-500",
  kind: "teacher-run-close",
  runId: "run:private-value",
  idempotencyKey: "close:500",
} as const;

function application(closeRun: () => object) {
  const records: UnhandledErrorRecord[] = [];
  const app = createApplication(
    {
      ...createServices(new RecordingProvider()),
      runClosure: { closeRun, closeClassRuns: vi.fn() },
    } as ReturnType<typeof createServices>,
    { onUnhandledError: (record) => records.push(record) },
  );
  return { app, records };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unexpected server failure log", () => {
  it("writes exactly one line with the route template, request id and stack; the response is unchanged", async () => {
    const failure = new TypeError("no such column: closed_by");
    const { app, records } = application(() => {
      throw failure;
    });
    const sent = await fetchJson(
      app,
      request("/api/v1/dashboard/runs/close", close, undefined, headers),
    );
    expect(sent.response.status).toBe(500);
    expect(JSON.parse(sent.text)).toMatchObject({
      error: { code: "server.error", retryable: true },
      requestId: "request:close-500",
    });
    expect(records).toEqual([
      {
        component: "teacher-product-http",
        event: "unhandled-error",
        method: "POST",
        route: "/api/v1/dashboard/runs/close",
        requestId: "request:close-500",
        name: "TypeError",
        message: "no such column: closed_by",
        stack: failure.stack,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("run:private-value");
    expect(JSON.stringify(records)).not.toContain(TEACHER_TOKEN);
  });

  it("does not log expected domain outcomes or successful responses", async () => {
    const domain = application(() => {
      throw new RunClosedError("teacher-ended");
    });
    const conflict = await fetchJson(
      domain.app,
      request("/api/v1/dashboard/runs/close", close, undefined, headers),
    );
    expect(conflict.response.status).toBe(409);
    expect(domain.records).toEqual([]);
    const ok = application(() =>
      RunsCloseResponseSchema.parse({
        protocolVersion: "0.1",
        requestId: "request:close-500",
        kind: "runs-close-response",
        closed: [],
        unchanged: [],
      }),
    );
    const sent = await fetchJson(
      ok.app,
      request("/api/v1/dashboard/runs/close", close, undefined, headers),
    );
    expect(sent.response.status).toBe(200);
    expect(ok.records).toEqual([]);
  });

  it("names parameterized routes by template and survives a failing sink or non-error throw", async () => {
    const app = new Hono();
    const records: UnhandledErrorRecord[] = [];
    app.use(
      "*",
      unhandledErrorLog((record) => records.push(record)),
    );
    // A rejected non-error value is still named by its type.
    const rejectText = vi.fn<() => Promise<Response>>().mockRejectedValue("text");
    app.get("/items/:id", () => safeOperation("request:item" as never, rejectText));
    const response = await app.request("/items/secret-id");
    expect(response.status).toBe(500);
    expect(records).toMatchObject([
      { route: "/items/:id", name: "string", message: "text", stack: null },
    ]);
    const throwing = new Hono();
    throwing.use(
      "*",
      unhandledErrorLog(() => {
        throw new Error("sink");
      }),
    );
    throwing.get("/x", () =>
      safeOperation("request:x" as never, () => {
        throw new Error("boom");
      }),
    );
    expect((await throwing.request("/x")).status).toBe(500);
  });

  it("writes the default record as one JSON line on stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const record: UnhandledErrorRecord = {
      component: "teacher-product-http",
      event: "unhandled-error",
      method: "GET",
      route: "/x",
      requestId: "request:x",
      name: "Error",
      message: "boom",
      stack: null,
    };
    writeUnhandledError(record);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(record)}\n`);
  });
});
