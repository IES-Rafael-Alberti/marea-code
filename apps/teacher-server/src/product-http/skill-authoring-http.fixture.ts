import { Hono } from "hono";
import {
  RequestIdSchema,
  Sha256DigestSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateResponseSchema,
  SkillIdSchema,
} from "@marea/protocol";
import type { MiddlewareHandler } from "hono";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ProductSkillAuthoringService } from "../teaching/authoring/dashboard-contracts.js";
import type { SkillBundle } from "../teaching/skills/skill-source.js";
import { protocolError } from "./response.js";
import { registerSkillAuthoringRoutes } from "./skill-authoring-http.boundary.js";

export const BASE_URL = "http://teacher.test";
const teacher: AuthenticatedIdentity = Object.freeze({
  classId: "class:physics",
  displayName: "Teacher Grace",
  role: "teacher",
  userId: "teacher:grace",
});
export const TEACHER_COOKIE = "teacher-session-token";
const skillText = "---\nname: practice\ndescription: Practice testing\n---\n";

const skill: SkillBundle = Object.freeze({
  compatibility: null,
  criteria: [],
  description: "Practice testing",
  digest: Sha256DigestSchema.parse(`sha256:${"d".repeat(64)}`),
  files: Object.freeze([
    Object.freeze({
      content: skillText,
      path: "SKILL.md",
      sizeBytes: new TextEncoder().encode(skillText).byteLength,
    }),
  ]),
  id: SkillIdSchema.parse("teacher/teacher:grace/practice"),
  kind: "didactic",
  license: null,
  name: "practice",
  source: "teacher",
});

export interface ServiceOverrides {
  readonly read?: ProductSkillAuthoringService["read"];
  readonly validate?: ProductSkillAuthoringService["validate"];
  readonly save?: ProductSkillAuthoringService["save"];
  readonly copy?: ProductSkillAuthoringService["copy"];
}

export function createRouteApp(overrides: ServiceOverrides = {}): {
  readonly app: Hono;
  readonly service: ProductSkillAuthoringService;
} {
  const service: ProductSkillAuthoringService = {
    copy:
      overrides.copy ??
      ((_identity, request) =>
        Promise.resolve(
          SkillAuthoringCopyResponseSchema.parse({
            classId: request.classId,
            kind: "skill-authoring-copied",
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            skill,
          }),
        )),
    read:
      overrides.read ??
      ((_identity, request) =>
        Promise.resolve(
          SkillAuthoringReadResponseSchema.parse({
            classId: request.classId,
            editable: request.target.scope === "personal" || _identity.role === "teacher",
            kind: "skill-authoring-read-result",
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            skill: request.target.scope === "personal" ? skill : null,
          }),
        )),
    save:
      overrides.save ??
      ((_identity, request) =>
        Promise.resolve(
          SkillAuthoringSaveResponseSchema.parse({
            classId: request.classId,
            kind: "skill-authoring-saved",
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            skill,
          }),
        )),
    validate:
      overrides.validate ??
      ((_identity, request) =>
        Promise.resolve(
          SkillAuthoringValidateResponseSchema.parse({
            classId: request.classId,
            kind: "skill-authoring-validated",
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            skill,
          }),
        )),
  };
  const app = new Hono();
  const policy: MiddlewareHandler = async (context, next) => {
    await next();
    return context.res;
  };
  const mutationPolicy: MiddlewareHandler = async (context, next) => {
    if (context.req.header("origin") !== "https://dashboard.test") {
      return protocolError(403, "request.invalid", false);
    }
    await next();
    return context.res;
  };
  registerSkillAuthoringRoutes({
    app,
    authenticate: (request) => {
      if (request.headers.get("cookie") !== `marea_teacher_session=${TEACHER_COOKIE}`) {
        throw new TeacherDomainError("auth.invalid");
      }
      return teacher;
    },
    mutationPolicy,
    policy,
    service,
  });
  return { app, service };
}

export function bodyRequest(
  path: string,
  body: string | Uint8Array | null,
  options: {
    readonly origin?: string;
    readonly cookie?: string;
    readonly contentLength?: string;
  } = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    host: "teacher.test",
  });
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.contentLength !== undefined) headers.set("content-length", options.contentLength);
  const init: RequestInit & { readonly duplex?: "half" } = {
    body:
      body === null || typeof body === "string"
        ? body
        : new Blob([body as Uint8Array<ArrayBuffer>]),
    headers,
    method: "POST",
    ...(body === null ? {} : { duplex: "half" as const }),
  };
  return new Request(`${BASE_URL}${path}`, init);
}

export function validReadRequest() {
  return {
    classId: "class:physics",
    kind: "skill-authoring-read" as const,
    protocolVersion: "0.1" as const,
    requestId: RequestIdSchema.parse("request:read"),
    target: { scope: "personal" as const, slug: "practice" },
  };
}

export const validSaveRequest = {
  classId: "class:physics",
  draft: {
    files: [{ content: "---\nname: practice\ndescription: Practice\n---\n", path: "SKILL.md" }],
    kind: "didactic" as const,
    slug: "practice",
  },
  expectedDigest: null,
  kind: "skill-authoring-save" as const,
  protocolVersion: "0.1" as const,
  requestId: RequestIdSchema.parse("request:save"),
};
