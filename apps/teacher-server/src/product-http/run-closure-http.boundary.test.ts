import { RUN_CLOSED_REASON_HEADER, RunsCloseResponseSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { RunClosedError, TeacherDomainError } from "../identity/errors.js";
import {
  createApplication,
  createServices,
  fetchJson,
  RecordingProvider,
  request,
  RUN_TOKEN,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const headers = {
  cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
  origin: "https://dashboard.test",
};
const envelope = { protocolVersion: "0.1", requestId: "request:close" } as const;
const single = {
  ...envelope,
  kind: "teacher-run-close",
  runId: "run:one",
  idempotencyKey: "close:1",
};
const group = {
  ...envelope,
  kind: "class-runs-close",
  classId: "class:physics",
  runIds: ["run:one", "run:two"],
  idempotencyKey: "close:2",
};
const paths = [
  ["/api/v1/dashboard/runs/close", single],
  ["/api/v1/dashboard/classes/close-runs", group],
] as const;

function setup(overrides: object = {}) {
  const result = { closed: ["run:one"], unchanged: ["run:two"] };
  const runClosure = {
    closeRun: vi.fn(() => RunsCloseResponseSchema.parse(response(result))),
    closeClassRuns: vi.fn(() => RunsCloseResponseSchema.parse(response(result))),
  };
  const app = createApplication({
    ...createServices(new RecordingProvider()),
    runClosure,
    ...overrides,
  });
  return { app, runClosure };
}

function response(result: { closed: string[]; unchanged: string[] }) {
  return { ...envelope, kind: "runs-close-response", ...result };
}

describe("teacher run closure HTTP", () => {
  it("ends one run and a class selection for the authenticated teacher, with a private response", async () => {
    const { app, runClosure } = setup();
    for (const [path, body] of paths) {
      const sent = await fetchJson(app, request(path, body, undefined, headers));
      expect(sent.response.status).toBe(200);
      expect(sent.response.headers.get("cache-control")).toContain("no-store");
      expect(RunsCloseResponseSchema.parse(JSON.parse(sent.text))).toMatchObject({
        closed: ["run:one"],
        unchanged: ["run:two"],
      });
    }
    expect(runClosure.closeRun).toHaveBeenCalledWith(
      expect.objectContaining({ role: "teacher", userId: "user:teacher" }),
      single,
    );
    expect(runClosure.closeClassRuns).toHaveBeenCalledWith(
      expect.objectContaining({ role: "teacher", userId: "user:teacher" }),
      group,
    );
  });

  it("requires a teacher cookie, an allowed mutation origin and an exact schema", async () => {
    const { app, runClosure } = setup();
    for (const [path, body] of paths) {
      const send = (
        extra: Record<string, string> | undefined,
        payload: object = body,
        to: string = path,
      ) => app.fetch(request(to, payload, undefined, extra));
      expect((await send({ origin: headers.origin })).status).toBe(401);
      expect(
        (await send({ ...headers, cookie: `marea_teacher_session=${SESSION_TOKEN}` })).status,
      ).toBe(403);
      expect((await send({ cookie: headers.cookie })).status).toBe(403);
      expect((await send({ ...headers, origin: "https://attacker.test" })).status).toBe(403);
      expect(
        (await app.fetch(request(path, body, TEACHER_TOKEN, { origin: headers.origin }))).status,
      ).toBe(401);
      expect((await send(headers, { ...body, closedBy: "user:other" })).status).toBe(400);
      expect((await send(headers, { ...body, idempotencyKey: undefined })).status).toBe(400);
      expect((await send(headers, body, `${path}?extra=1`)).status).toBe(403);
    }
    expect(runClosure.closeRun).not.toHaveBeenCalled();
    expect(runClosure.closeClassRuns).not.toHaveBeenCalled();
  });

  it.each([
    ["dashboard.forbidden", 403],
    ["run.unavailable", 409],
    ["request.conflict", 409],
  ] as const)("maps a %s refusal to a safe %s response", async (code, status) => {
    const refuse = () => {
      throw new TeacherDomainError(code);
    };
    const { app } = setup({ runClosure: { closeRun: refuse, closeClassRuns: refuse } });
    for (const [path, body] of paths) {
      const sent = await fetchJson(app, request(path, body, undefined, headers));
      expect(sent.response.status).toBe(status);
      expect(sent.text).not.toContain("run:one");
    }
  });

  it("offers no closing routes when the host composes no closure service", async () => {
    const { app } = setup({ runClosure: undefined });
    for (const [path, body] of paths) {
      expect((await app.fetch(request(path, body, undefined, headers))).status).toBe(404);
    }
  });
});

describe("explaining a closed run to the student", () => {
  const presence = (authorizeLease: () => never) => {
    const base = createServices(new RecordingProvider());
    return createApplication({ ...base, runs: { ...base.runs, authorizeLease } });
  };
  const probe = (app: ReturnType<typeof createApplication>) =>
    fetchJson(app, request("/v1/runs/presence", { requestId: "request:presence" }, RUN_TOKEN));

  it.each(["teacher-ended", "class-ended", "session-expired"] as const)(
    "adds the %s reason to the run.unavailable refusal without changing its body",
    async (reason) => {
      const sent = await probe(
        presence(() => {
          throw new RunClosedError(reason);
        }),
      );
      expect(sent.response.status).toBe(409);
      expect(sent.response.headers.get(RUN_CLOSED_REASON_HEADER)).toBe(reason);
      expect(JSON.parse(sent.text)).toEqual({
        error: { code: "run.unavailable", retryable: false },
        protocolVersion: "0.1",
        requestId: "request:presence",
      });
    },
  );

  it("sends no reason for an ordinary refusal", async () => {
    const sent = await probe(
      presence(() => {
        throw new TeacherDomainError("run.unavailable");
      }),
    );
    expect(sent.response.status).toBe(409);
    expect(sent.response.headers.has(RUN_CLOSED_REASON_HEADER)).toBe(false);
  });
});
