import type { Hono, MiddlewareHandler } from "hono";
import {
  MAX_SKILL_RESPONSE_BYTES,
  SkillAuthoringCopyRequestSchema,
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringReadRequestSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveRequestSchema,
  SkillAuthoringSaveResponseSchema,
  SkillAuthoringValidateRequestSchema,
  SkillAuthoringValidateResponseSchema,
  type RequestId,
} from "@marea/protocol";
import { isJson } from "@marea/transport-server";
import * as z from "zod";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ProductSkillAuthoringService } from "../teaching/authoring/dashboard-contracts.js";
import { SkillAuthoringError } from "../teaching/authoring/errors.js";
import { BundledSkillError } from "../teaching/skills/errors.js";
import { SkillAuthoringServiceError } from "../teaching/authoring-runtime/skill-authoring-service.js";
import { jsonResponse, protocolError } from "./response.js";

const SMALL_REQUEST_BYTES = 64 * 1_024;
const MAX_STREAM_CHUNKS = 4_096;

export interface SkillAuthoringRouteDependencies {
  readonly app: Hono;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly policy: MiddlewareHandler;
  readonly mutationPolicy: MiddlewareHandler;
  readonly service: ProductSkillAuthoringService;
}

type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };
type JsonParseResult = { readonly value: unknown } | null;

/** Registers only the four teacher-cookie authoring routes on an existing Hono app. */
export function registerSkillAuthoringRoutes(dependencies: SkillAuthoringRouteDependencies): void {
  registerRoute(
    dependencies,
    "/api/v1/dashboard/skill-authoring/read",
    SkillAuthoringReadRequestSchema,
    SkillAuthoringReadResponseSchema,
    SMALL_REQUEST_BYTES,
    dependencies.policy,
    (identity, request) => dependencies.service.read(identity, request),
  );
  registerRoute(
    dependencies,
    "/api/v1/dashboard/skill-authoring/validate",
    SkillAuthoringValidateRequestSchema,
    SkillAuthoringValidateResponseSchema,
    MAX_SKILL_RESPONSE_BYTES,
    dependencies.mutationPolicy,
    (identity, request) => dependencies.service.validate(identity, request),
  );
  registerRoute(
    dependencies,
    "/api/v1/dashboard/skill-authoring/save",
    SkillAuthoringSaveRequestSchema,
    SkillAuthoringSaveResponseSchema,
    MAX_SKILL_RESPONSE_BYTES,
    dependencies.mutationPolicy,
    (identity, request) => dependencies.service.save(identity, request),
  );
  registerRoute(
    dependencies,
    "/api/v1/dashboard/skill-authoring/copy",
    SkillAuthoringCopyRequestSchema,
    SkillAuthoringCopyResponseSchema,
    SMALL_REQUEST_BYTES,
    dependencies.mutationPolicy,
    (identity, request) => dependencies.service.copy(identity, request),
  );
}

function registerRoute<
  TRequest extends { readonly requestId: RequestId },
  TResponse extends object,
>(
  dependencies: SkillAuthoringRouteDependencies,
  path: string,
  requestSchema: z.ZodType<TRequest>,
  responseSchema: z.ZodType<TResponse>,
  maxRequestBytes: number,
  policy: MiddlewareHandler,
  operation: (identity: AuthenticatedIdentity, request: TRequest) => Promise<TResponse>,
): void {
  dependencies.app.post(path, policy, async (context) => {
    const parsed = await parseSkillAuthoringJson(context.req.raw, requestSchema, maxRequestBytes);
    if (!parsed.ok) return parsed.response;
    try {
      const response = await operation(dependencies.authenticate(context.req.raw), parsed.value);
      return boundedSkillAuthoringJson(responseSchema, response, parsed.value.requestId);
    } catch (error: unknown) {
      return authoringErrorResponse(error, parsed.value.requestId);
    }
  });
}

/** Parses a bounded JSON request without buffering beyond the supplied byte limit. */
export async function parseSkillAuthoringJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<ParseResult<T>> {
  if (!isJson(request.headers.get("content-type") ?? undefined)) {
    return { ok: false, response: protocolError(415, "request.invalid", false) };
  }
  const body = await readBoundedUtf8(request, maxBytes);
  if (body instanceof Response) return { ok: false, response: body };
  const json = parseJsonBody(body);
  if (json === null) {
    return { ok: false, response: protocolError(400, "request.invalid", false) };
  }
  const parsed = schema.safeParse(json.value);
  if (!parsed.success) return { ok: false, response: protocolError(400, "request.invalid", false) };
  return { ok: true, value: parsed.data };
}

function parseJsonBody(body: string): JsonParseResult {
  try {
    return { value: JSON.parse(body) };
  } catch {
    return null;
  }
}

async function readBoundedUtf8(request: Request, maxBytes: number): Promise<string | Response> {
  const expectedLength = declaredLength(request, maxBytes);
  if (expectedLength instanceof Response) return expectedLength;
  if (request.body === null) {
    return protocolError(400, "request.invalid", false);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  try {
    return await readBoundedChunks(reader, decoder, parts, expectedLength, maxBytes, 0, 0);
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  parts: string[],
  expectedLength: number | undefined,
  maxBytes: number,
  bytesRead: number,
  chunks: number,
): Promise<string | Response> {
  let chunk: Awaited<ReturnType<typeof reader.read>>;
  try {
    chunk = await reader.read();
  } catch {
    return protocolError(500, "server.error", true);
  }
  if (chunk.done) {
    try {
      decoder.decode();
    } catch {
      return protocolError(400, "request.invalid", false);
    }
    if (expectedLength !== undefined && expectedLength !== bytesRead) {
      return protocolError(400, "request.invalid", false);
    }
    return parts.join("");
  }
  const nextChunks = chunks + 1;
  const nextBytes = bytesRead + chunk.value.byteLength;
  if (nextChunks > MAX_STREAM_CHUNKS || nextBytes > maxBytes) {
    cancelBody(reader);
    return protocolError(413, "request.invalid", false);
  }
  let decoded: string;
  try {
    decoded = decoder.decode(chunk.value, { stream: true });
  } catch {
    cancelBody(reader);
    return protocolError(400, "request.invalid", false);
  }
  parts.push(decoded);
  return readBoundedChunks(reader, decoder, parts, expectedLength, maxBytes, nextBytes, nextChunks);
}

function declaredLength(request: Request, maxBytes: number): number | Response | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) return protocolError(400, "request.invalid", false);
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > maxBytes
    ? protocolError(413, "request.invalid", false)
    : length;
}

function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
}

export function boundedSkillAuthoringJson<T extends object>(
  schema: z.ZodType<T>,
  value: unknown,
  requestId: RequestId,
  maxBytes = MAX_SKILL_RESPONSE_BYTES,
): Response {
  const parsed = schema.parse(value);
  const body = JSON.stringify(parsed);
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    return protocolError(500, "server.error", true, requestId);
  }
  return jsonResponse(parsed);
}

export function authoringErrorResponse(error: unknown, requestId: RequestId): Response {
  if (error instanceof TeacherDomainError) {
    return error.code === "auth.invalid"
      ? protocolError(401, "auth.invalid", false, requestId)
      : protocolError(403, "request.invalid", false, requestId);
  }
  if (error instanceof SkillAuthoringError) {
    if (error.code === "SKILL_EXISTS" || error.code === "STALE_SKILL_DIGEST") {
      return protocolError(409, "request.invalid", false, requestId);
    }
    if (error.code === "SKILL_MISSING")
      return protocolError(422, "request.invalid", false, requestId);
    if (error.code === "UNSAFE_AUTHORING_INPUT") {
      return protocolError(400, "request.invalid", false, requestId);
    }
    if (error.code === "AUTHORING_LIMIT") {
      return protocolError(413, "request.invalid", false, requestId);
    }
    return protocolError(500, "server.error", true, requestId);
  }
  if (error instanceof BundledSkillError || error instanceof SkillAuthoringServiceError) {
    return protocolError(422, "request.invalid", false, requestId);
  }
  return protocolError(500, "server.error", true, requestId);
}
