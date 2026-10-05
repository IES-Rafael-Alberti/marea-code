import type {
  InferenceProvider,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";
import {
  ActiveRunDashboardResponseSchema,
  AppendRunEventsResponseSchema,
  ClassBootstrapResponseSchema,
  CloseRunResponseSchema,
  CredentialLoginResponseSchema,
  CredentialLogoutResponseSchema,
  EnrollStudentResponseSchema,
  OpenRunResponseSchema,
  RenewRunLeaseResponseSchema,
  type CredentialLoginRequest,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { TeacherProductHttpApplication, TeacherProductServices } from "./contracts.js";
import { createTeacherProductHttp } from "./teacher-product-http.boundary.js";
import type { ProductTeachingConfigurationService } from "../teaching/configuration/dashboard-contracts.js";

/** Existing non-configuration fixtures must not silently enable a teaching policy. */
export const unavailableTeachingConfiguration: ProductTeachingConfigurationService = {
  classes() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  read() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  catalog() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  save() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
};

export const unavailableSkillAuthoring: TeacherProductServices["skillAuthoring"] = {
  read() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  validate() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  save() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
  copy() {
    throw new TeacherDomainError("dashboard.forbidden");
  },
};

export const BASE_URL = "http://teacher.test";
export const SESSION_TOKEN = "student_session_token_00000000000000000000";
export const TEACHER_TOKEN = "teacher_session_token_00000000000000000000";
export const RUN_TOKEN = "student_run_token_000000000000000000000";
const NOW = "2026-09-04T08:00:00.000Z";

const student: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Ada",
  role: "student",
  userId: "user:student",
};

export const teacher: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Teacher Grace",
  role: "teacher",
  userId: "user:teacher",
};

export function request(
  path: string,
  body: object,
  credential?: string,
  headers?: Readonly<Record<string, string>>,
): Request {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: "teacher.test",
    ...headers,
  });
  if (credential !== undefined) requestHeaders.set("authorization", `Bearer ${credential}`);
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: requestHeaders,
    method: "POST",
  });
}

export async function fetchJson(app: TeacherProductHttpApplication, input: Request) {
  const response = await app.fetch(input);
  return { response, text: await response.text() };
}

export class RecordingProvider implements InferenceProvider {
  public readonly requests: InferenceProviderRequest[] = [];

  public async *stream(request: InferenceProviderRequest): AsyncIterable<InferenceProviderEvent> {
    await Promise.resolve();
    this.requests.push(request);
    yield { text: "I can help.", type: "text-delta" };
    yield { inputTokens: 4, outputTokens: 3, type: "usage" };
    yield { finishReason: "stop", type: "completed" };
  }
}

function loginResponse(request: CredentialLoginRequest) {
  const isTeacher = request.credentials.login === "teacher";
  return CredentialLoginResponseSchema.parse({
    kind: "credential-authenticated",
    principal: isTeacher
      ? { displayName: teacher.displayName, role: "teacher" }
      : { displayName: student.displayName, role: "student" },
    protocolVersion: "0.1",
    requestId: request.requestId,
    session: {
      expiresAt: "2026-09-04T08:30:00.000Z",
      issuedAt: NOW,
      token: isTeacher ? TEACHER_TOKEN : SESSION_TOKEN,
    },
  });
}

/** Session tokens the fixture identity service was asked to revoke, in order. */
export const loggedOut: string[] = [];

export function createServices(provider: InferenceProvider): TeacherProductServices {
  return {
    teachingConfiguration: unavailableTeachingConfiguration,
    skillAuthoring: unavailableSkillAuthoring,
    evaluations: {
      query() {
        throw new TeacherDomainError("run.unavailable");
      },
      generate() {
        throw new TeacherDomainError("run.unavailable");
      },
      approve() {
        throw new TeacherDomainError("run.unavailable");
      },
    },
    notices: {
      lookup() {
        throw new Error("Not implemented.");
      },
      publish() {
        throw new TeacherDomainError("run.unavailable");
      },
      pending() {
        throw new TeacherDomainError("run.unavailable");
      },
      acknowledge() {
        throw new TeacherDomainError("run.unavailable");
      },
    },
    history: {
      listClassSessions() {
        throw new TeacherDomainError("run.unavailable");
      },
      readRun() {
        throw new TeacherDomainError("run.unavailable");
      },
      listSessions() {
        throw new TeacherDomainError("run.unavailable");
      },
    },
    skills: {
      read() {
        throw new TeacherDomainError("run.unavailable");
      },
    },
    classroom: {
      load(_identity, request) {
        return ClassBootstrapResponseSchema.parse({
          activeRun: null,
          classroom: { displayName: "Physics" },
          kind: "class-bootstrapped",
          modelAlias: "marea",
          principal: { displayName: student.displayName, role: "student" },
          protocolVersion: "0.1",
          requestId: request.requestId,
        });
      },
    },
    dashboard: {
      query(_context, query) {
        return ActiveRunDashboardResponseSchema.parse({
          generatedAt: NOW,
          kind: "active-runs-response",
          nextCursor: null,
          protocolVersion: "0.1",
          requestId: query.requestId,
          runs: [
            {
              classDisplayName: "Physics",
              highestDurableSequence: 2,
              lastActivityAt: NOW,
              pendingApproval: false,
              projectDisplayName: "Wave lab",
              runId: "run:one",
              startedAt: NOW,
              state: "active",
              studentDisplayName: student.displayName,
            },
          ],
          viewer: { displayName: teacher.displayName, role: "teacher" },
        });
      },
    },
    identity: {
      authenticate(token) {
        if (token === SESSION_TOKEN) return { identity: student, principal: student };
        if (token === TEACHER_TOKEN) return { identity: teacher, principal: teacher };
        throw new TeacherDomainError("auth.invalid");
      },
      enroll(request) {
        return Promise.resolve(
          EnrollStudentResponseSchema.parse({
            kind: "student-invitation-enrolled",
            principal: { displayName: request.displayName, role: "student" },
            protocolVersion: "0.1",
            requestId: request.requestId,
            session: {
              expiresAt: "2026-09-04T08:30:00.000Z",
              issuedAt: NOW,
              token: SESSION_TOKEN,
            },
          }),
        );
      },
      login(request) {
        return Promise.resolve(loginResponse(request));
      },
      selectClass(token, classId) {
        if (token === SESSION_TOKEN && classId === student.classId) return student;
        throw new TeacherDomainError("request.conflict");
      },
      logout(token, requestId) {
        loggedOut.push(token);
        return CredentialLogoutResponseSchema.parse({
          alreadyLoggedOut: false,
          kind: "credential-logged-out",
          loggedOutAt: NOW,
          protocolVersion: "0.1",
          requestId,
        });
      },
    },
    modelClock: { now: () => NOW },
    modelUsage: { providerFor: (_lease, _requestId, resolved) => resolved },
    providers: { resolve: (providerId) => (providerId === "openrouter" ? provider : undefined) },
    retry: { wait: () => Promise.resolve() },
    runs: {
      append(_token, request) {
        return AppendRunEventsResponseSchema.parse({
          highestDurableSequence: request.events.at(-1)?.sequence ?? 0,
          kind: "run-events-acknowledged",
          protocolVersion: "0.1",
          requestId: request.requestId,
        });
      },
      authorizeLease(token) {
        if (token !== RUN_TOKEN) throw new TeacherDomainError("run.unavailable");
        return {
          providerRoute: { model: "private-upstream-model", providerId: "openrouter" },
          runId: "run:one",
          studentId: student.userId,
        };
      },
      close(_token, requestId) {
        return CloseRunResponseSchema.parse({
          alreadyClosed: false,
          protocolVersion: "0.1",
          requestId,
          runId: "run:one",
          state: "closed",
        });
      },
      closeAuthenticated(_identity, request) {
        return CloseRunResponseSchema.parse({
          alreadyClosed: false,
          protocolVersion: "0.1",
          requestId: request.requestId,
          runId: "run:one",
          state: "closed",
        });
      },
      open(_identity, request) {
        return OpenRunResponseSchema.parse({
          highestDurableSequence: 1,
          lease: {
            expiresAt: "2026-09-04T08:10:00.000Z",
            issuedAt: NOW,
            runId: "run:one",
            token: RUN_TOKEN,
          },
          protocolVersion: "0.1",
          requestId: request.requestId,
          snapshot: {
            agentMode: "tutoring",
            didacticSkills: [],
            id: "snapshot:one",
            modelAlias: "marea",
            prompt: {
              content: "Support the student.",
              digest: `sha256:${"a".repeat(64)}`,
              version: "prompt:v1",
            },
            teacherToolPolicy: {
              restrictions: [{ effect: "require-approval", tool: "write_file" }],
              version: "policy:v1",
            },
          },
        });
      },
      renew(_identity, request) {
        return RenewRunLeaseResponseSchema.parse({
          kind: "run-lease-renewed",
          lease: {
            expiresAt: "2026-09-04T08:10:00.000Z",
            issuedAt: NOW,
            runId: "run:one",
            token: RUN_TOKEN,
          },
          protocolVersion: "0.1",
          requestId: request.requestId,
        });
      },
    },
  };
}

export function createApplication(
  services = createServices(new RecordingProvider()),
  overrides: { readonly cookieName?: string; readonly secure?: boolean } = {},
): TeacherProductHttpApplication {
  return createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://dashboard.test"],
    ...(overrides.cookieName === undefined ? {} : { dashboardCookieName: overrides.cookieName }),
    ...(overrides.secure === undefined ? {} : { secureDashboardCookie: overrides.secure }),
    serverVersion: "0.2.0",
    services,
  });
}

export const capabilitiesRequest = {
  clientVersion: "0.2.0",
  requestId: "request:capabilities",
  supportedProtocolVersions: ["0.1"],
};

export const enrollmentRequest = {
  credentials: { login: "student", password: "student-password" },
  displayName: "Student Ada",
  invitationCode: "physics_invite_2026",
  kind: "student-invitation-enrollment",
  protocolVersion: "0.1",
  requestId: "request:enroll",
};

export const openRequest = {
  clientSessionId: "client:one",
  clientVersion: "0.2.0",
  idempotencyKey: "open:one",
  intent: { kind: "new" },
  project: { displayName: "Wave lab" },
  protocolVersion: "0.1",
  requestId: "request:open",
};

export const eventRequest = {
  events: [
    {
      content: "Please help.",
      eventId: "event:student",
      eventType: "student-message",
      occurredAt: "2026-09-04T08:00:00.000Z",
      sequence: 2,
    },
  ],
  kind: "run-events-append",
  protocolVersion: "0.1",
  requestId: "request:events",
};

export const modelRequest = {
  kind: "model-gateway-request",
  messages: [{ content: "Please help.", role: "student" }],
  modelAlias: "marea",
  protocolVersion: "0.1",
  requestId: "request:model",
  tools: [],
};
