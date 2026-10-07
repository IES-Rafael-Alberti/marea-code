import {
  CURRENT_PROTOCOL_VERSION,
  SaveTeachingConfigurationRequestSchema,
  ProtocolErrorResponseSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingClassesQuerySchema,
  TeachingClassesResponseSchema,
  TeachingCatalogQuerySchema,
  TeachingConfigurationQuerySchema,
  TeachingConfigurationResponseSchema,
  type TeachingSettings,
  type SaveTeachingConfigurationRequest,
} from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { TeacherDomainError } from "../identity/errors.js";
import { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { ProductTeachingConfigurationService } from "../teaching/configuration/dashboard-contracts.js";
import {
  BASE_URL,
  createApplication,
  createServices,
  fetchJson,
  RecordingProvider,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const teacherCookie = { cookie: `marea_teacher_session=${TEACHER_TOKEN}` };
const studentCookie = { cookie: `marea_teacher_session=${SESSION_TOKEN}` };
const origin = { origin: "https://dashboard.test" };
const path = (action: string) => `/api/v1/dashboard/teaching/${action}`;

function settings(): TeachingSettings {
  return {
    agentMode: "tutoring",
    automaticEvaluation: false,
    classInstructions: { tutoring: "Tutoring.", free: "Free." },
    selection: { didactic: [], evaluation: [] },
  };
}

function classesQuery() {
  return TeachingClassesQuerySchema.parse({
    afterClassId: null,
    kind: "teaching-classes-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:classes",
  });
}

function readQuery() {
  return TeachingConfigurationQuerySchema.parse({
    classId: "class:one",
    kind: "teaching-configuration-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:read",
  });
}

function catalogQuery() {
  return TeachingCatalogQuerySchema.parse({
    afterSkillId: null,
    classId: "class:one",
    kind: "teaching-catalog-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:catalog",
  });
}

function saveRequest(overrides: Partial<TeachingSettings> = {}) {
  return SaveTeachingConfigurationRequestSchema.parse({
    classId: "class:one",
    expectedVersion: null,
    kind: "teaching-configuration-save",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:save",
    settings: { ...settings(), ...overrides },
  });
}

function teachingRequest(
  action: string,
  body: object,
  headers: Readonly<Record<string, string>> = { ...origin, ...teacherCookie },
): Request {
  const requestHeaders = new Headers({ "content-type": "application/json", host: "teacher.test" });
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return new Request(`${BASE_URL}${path(action)}`, {
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
  });
}

function recordedService(): ProductTeachingConfigurationService {
  return {
    catalog: vi.fn(),
    classes: vi.fn(() => Promise.resolve({ kind: "teaching-classes-response" } as never)),
    read: vi.fn(),
    save: vi.fn(),
  };
}

describe("teaching HTTP boundary", () => {
  it("serves awaited teacher responses and rejects students and missing cookies", async () => {
    const classes = vi.fn(() =>
      Promise.resolve(
        TeachingClassesResponseSchema.parse({
          classes: [{ classId: "class:one", displayName: "One" }],
          kind: "teaching-classes-response",
          nextAfterClassId: null,
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          requestId: "request:classes",
        }),
      ),
    );
    const service: ProductTeachingConfigurationService = {
      catalog: vi.fn(() => Promise.resolve({} as never)),
      classes,
      read: vi.fn(() => Promise.resolve({} as never)),
      save: vi.fn(() => Promise.resolve({} as never)),
    };
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: service,
    });
    const served = await fetchJson(app, teachingRequest("classes", classesQuery()));
    expect(served.response.status).toBe(200);
    expect(served.text).toContain("teaching-classes-response");
    for (const [action, body, headers] of [
      ["classes", classesQuery(), studentCookie],
      ["read", readQuery(), {}],
      ["catalog", catalogQuery(), studentCookie],
      ["save", saveRequest(), studentCookie],
    ] as const) {
      expect(
        (await app.fetch(teachingRequest(action, body, { ...origin, ...headers }))).status,
      ).toBe(headers === studentCookie ? 403 : 401);
    }
    expect(classes).toHaveBeenCalledOnce();
  });

  it("enforces host, origin, search, media type, bounds and schema", async () => {
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: recordedService(),
    });
    for (const [status, request] of [
      [
        403,
        teachingRequest("classes", classesQuery(), {
          ...origin,
          ...teacherCookie,
          host: "attacker.test",
        }),
      ],
      [403, teachingRequest("save", saveRequest(), teacherCookie)],
      [
        403,
        teachingRequest("save", saveRequest(), {
          ...teacherCookie,
          origin: "https://attacker.test",
        }),
      ],
      [
        415,
        new Request(`${BASE_URL}${path("classes")}`, {
          body: "{}",
          headers: { host: "teacher.test", origin: origin.origin },
          method: "POST",
        }),
      ],
      [
        400,
        new Request(`${BASE_URL}${path("classes")}`, {
          body: "{",
          headers: {
            "content-type": "application/json",
            host: "teacher.test",
            origin: origin.origin,
          },
          method: "POST",
        }),
      ],
      [
        413,
        teachingRequest("classes", classesQuery(), {
          ...origin,
          ...teacherCookie,
          "content-length": "70000",
        }),
      ],
      [
        413,
        teachingRequest("save", saveRequest(), {
          ...origin,
          ...teacherCookie,
          "content-length": String(4 * 1_024 * 1_024 + 1),
        }),
      ],
      [400, teachingRequest("classes", { ...classesQuery(), kind: "wrong" })],
    ] as const) {
      const response = await app.fetch(request);
      expect(response.status, `${request.url} -> ${await response.text()}`).toBe(status);
    }
    expect(
      (
        await app.fetch(
          new Request(`${BASE_URL}${path("classes")}?kind=extra`, {
            body: JSON.stringify(classesQuery()),
            headers: {
              "content-type": "application/json",
              cookie: teacherCookie.cookie,
              host: "teacher.test",
              origin: origin.origin,
            },
            method: "POST",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("rejects URL search on the save route before authentication", async () => {
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: recordedService(),
    });
    const request = new Request(`${BASE_URL}${path("save")}?kind=extra`, {
      body: JSON.stringify(saveRequest()),
      headers: {
        "content-type": "application/json",
        cookie: teacherCookie.cookie,
        host: "teacher.test",
        origin: origin.origin,
      },
      method: "POST",
    });
    expect((await app.fetch(request)).status).toBe(403);
  });

  it("sanitizes awaited service failures with the shared protocol envelope", async () => {
    const cases: readonly [Error, number, string, boolean][] = [
      [new TeachingConfigurationError("operator-unconfigured"), 503, "server.error", false],
      [new TeachingConfigurationError("skill-unavailable"), 422, "request.invalid", false],
      [new TeacherDomainError("request.conflict"), 409, "request.invalid", false],
      [new TeacherDomainError("run.unavailable"), 409, "run.unavailable", false],
      [new TeacherDomainError("dashboard.forbidden"), 403, "request.invalid", false],
      [new TeacherDomainError("auth.invalid"), 401, "auth.invalid", false],
      [new Error("private detail"), 500, "server.error", true],
    ];
    for (const [failure, status, code, retryable] of cases) {
      const service: ProductTeachingConfigurationService = {
        catalog: vi.fn(),
        classes: vi.fn(() => Promise.reject(failure)),
        read: vi.fn(),
        save: vi.fn(),
      };
      const app = createApplication({
        ...createServices(new RecordingProvider()),
        teachingConfiguration: service,
      });
      const response = await app.fetch(teachingRequest("classes", classesQuery()));
      const parsed = ProtocolErrorResponseSchema.parse(await response.json());
      expect(response.status).toBe(status);
      expect(parsed.error).toEqual({ code, retryable });
      expect(parsed.requestId).toBe("request:classes");
    }
  });

  it("accepts wire-valid maximally escaped instructions without domain evaluation", async () => {
    const escaped = "\u0000".repeat(262_144);
    const service = recordedService();
    const save = vi.fn(
      (identity: AuthenticatedIdentity, request: SaveTeachingConfigurationRequest) => {
        if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
        return Promise.resolve(
          SaveTeachingConfigurationResponseSchema.parse({
            classId: request.classId,
            configuration: { settings: request.settings, version: "revision:one" },
            kind: "teaching-configuration-saved",
            protocolVersion: CURRENT_PROTOCOL_VERSION,
            requestId: request.requestId,
          }),
        );
      },
    );
    service.save = save;
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: service,
    });
    const response = await app.fetch(
      teachingRequest(
        "save",
        saveRequest({ classInstructions: { free: escaped, tutoring: escaped } }),
      ),
    );
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
    const lastCall = save.mock.lastCall;
    if (lastCall === undefined) throw new Error("The save service was not called.");
    const passedRequest = SaveTeachingConfigurationRequestSchema.parse(lastCall[1]);
    expect(passedRequest.settings.classInstructions.free).toHaveLength(262_144);
  });

  it("enforces the shared 4 MiB UTF-8 response bound without private details", async () => {
    const service = recordedService();
    const huge = "a".repeat(40_000);
    service.classes = vi.fn(() =>
      Promise.resolve({
        classes: Array.from({ length: 120 }, () => ({ displayName: huge })),
        kind: "teaching-classes-response",
        nextAfterClassId: null,
      } as never),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: service,
    });
    const response = await app.fetch(teachingRequest("classes", classesQuery()));
    stdout.mockRestore();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain('"code":"server.error"');
    const parsed = ProtocolErrorResponseSchema.parse(JSON.parse(text));
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.requestId).toBe("request:classes");
    expect(text.length).toBeLessThan(1_000);
  });

  it("accepts a teaching response at exactly the 4 MiB byte bound", async () => {
    const service = recordedService();
    const envelope = { kind: "teaching-classes-response" };
    const prefix = JSON.stringify({ ...envelope, filler: "" });
    const filler = "a".repeat(4 * 1_024 * 1_024 - prefix.length);
    service.classes = vi.fn(() => Promise.resolve({ ...envelope, filler } as never));
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: service,
    });
    const response = await app.fetch(teachingRequest("classes", classesQuery()));
    expect(response.status).toBe(200);
  });

  it("keeps private error details out of HTTP responses and application logs", async () => {
    const service = recordedService();
    service.classes = vi.fn(() => Promise.reject(new Error("private operator route detail")));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = createApplication({
      ...createServices(new RecordingProvider()),
      teachingConfiguration: service,
    });
    const response = await app.fetch(teachingRequest("classes", classesQuery()));
    const writes = stdout.mock.calls.map(([value]) => String(value)).join("");
    stdout.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private operator route detail");
    expect(writes).not.toContain("BOUNDARYERR");
    expect(writes).not.toContain("private operator route detail");
  });
});

it("negotiates the writing-gate extension and preserves strict baseline teaching responses", async () => {
  const query = readQuery();
  const configuration = {
    version: "revision:gate",
    settings: { ...settings(), socraticMode: "strict" as const },
  };
  const service = recordedService();
  const save = vi.fn(() =>
    Promise.resolve(
      SaveTeachingConfigurationResponseSchema.parse({
        ...query,
        kind: "teaching-configuration-saved",
        configuration,
      }),
    ),
  );
  const app = createApplication({
    ...createServices(new RecordingProvider()),
    teachingConfiguration: {
      ...service,
      save,
      read: () =>
        Promise.resolve({
          ...query,
          kind: "teaching-configuration-response",
          configuration,
          operatorReady: true,
        }),
    },
  });
  for (const extended of [false, true]) {
    const headers = {
      ...origin,
      ...teacherCookie,
      ...(extended ? { "x-marea-socratic-gate": "1" } : {}),
    };
    const read = await app.fetch(teachingRequest("read", query, headers));
    const body = TeachingConfigurationResponseSchema.parse(await read.json());
    expect(read.status).toBe(200);
    expect(body).toMatchObject({
      configuration: { settings: { agentMode: "tutoring" } },
      operatorReady: true,
    });
    expect(JSON.stringify(body).includes('"socraticMode":"strict"')).toBe(extended);
    const saved = await app.fetch(
      teachingRequest("save", saveRequest(extended ? { socraticMode: "strict" } : {}), headers),
    );
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json()).includes('"socraticMode":"strict"')).toBe(extended);
  }
  const denied = await app.fetch(teachingRequest("save", saveRequest({ socraticMode: "strict" })));
  expect(denied.status).toBe(400);
  expect(save).toHaveBeenCalledTimes(2);
});
