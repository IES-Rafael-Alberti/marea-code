import { StudentHttpError } from "./http-error.js";
import { CLASS_CONFIGURATION_REQUIRED_HEADER } from "@marea/protocol";
export { StudentHttpError } from "./http-error.js";
import { boundedEventDelivery } from "./event-delivery.js";
import {
  SIGN_IN_HTTP_PATHS,
  authenticatedJson,
  signInMethods,
  type SignInHttpPaths,
} from "./http-sign-in.boundary.js";
import {
  RequestIdSchema,
  AppendRunEventsResponseSchema,
  MAX_RUN_EVENTS_REQUEST_BYTES,
  CapabilitiesResponseSchema,
  ClassBootstrapOutcomeSchema,
  CloseRunResponseSchema,
  CredentialLoginResponseSchema,
  EnrollStudentResponseSchema,
  ModelGatewayStreamChunkSchema,
  OpenRunResponseSchema,
  ProtocolErrorResponseSchema,
  RenewRunLeaseRequestSchema,
  RenewRunLeaseResponseSchema,
  RunSkillRequestSchema,
  RunSkillResponseSchema,
  MAX_SKILL_RESPONSE_BYTES,
  type AppendRunEventsRequest,
  type CapabilitiesRequest,
  type CapabilitiesResponse,
  type ClassBootstrapOutcome,
  type ClassBootstrapRequest,
  type CloseRunRequest,
  type CloseRunResponse,
  type CredentialLoginRequest,
  type CredentialLoginResponse,
  type EnrollStudentRequest,
  type EnrollStudentResponse,
  type ModelGatewayRequest,
  type ModelGatewayStreamChunk,
  type OpenRunRequest,
  type OpenRunResponse,
  type RequestId,
  type RenewRunLeaseRequest,
  type RenewRunLeaseResponse,
  type RunToken,
  type RunSkillRequest,
  type SessionToken,
} from "@marea/protocol";
import type { MareaModelGateway } from "@marea/deepagents-adapter";
import * as z from "zod";

import type { AuthenticationResult, StudentServer } from "./contracts.js";

const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_STREAM_LINE_BYTES = 131_072;
const DEFAULT_TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();

export const STUDENT_HTTP_PATHS = Object.freeze({
  appendEvents: "/v1/runs/events",
  ...SIGN_IN_HTTP_PATHS,
  bootstrap: "/v1/classes/bootstrap",
  capabilities: "/v1/capabilities",
  closeRun: "/v1/runs/close",
  enroll: "/v1/auth/enroll",
  login: "/v1/auth/login",
  modelGateway: "/v1/model/stream",
  openRun: "/v1/runs/open",
  renewLease: "/v1/runs/lease-renew",
  readSkill: "/v1/runs/skills/read",
});

export interface StudentHttpPaths extends SignInHttpPaths {
  readonly appendEvents: string;
  readonly bootstrap: string;
  readonly capabilities: string;
  readonly closeRun: string;
  readonly enroll: string;
  readonly login: string;
  readonly modelGateway: string;
  readonly openRun: string;
  readonly renewLease?: string;
  readonly readSkill?: string;
}

export type StudentFetch = (request: Request) => Promise<Response>;

export interface StudentHttpOptions {
  readonly baseUrl: string;
  readonly fetch?: StudentFetch;
  readonly paths?: StudentHttpPaths;
  readonly timeoutMs?: number;
}

export interface ModelGatewayHttpOptions extends StudentHttpOptions {
  readonly runToken: () => Promise<RunToken>;
}

export interface HttpClient {
  json<T extends { readonly requestId: RequestId }>(
    path: string,
    requestId: RequestId,
    body: object,
    schema: z.ZodType<T>,
    credential?: string,
    maxResponseBytes?: number,
    maxRequestBytes?: number,
  ): Promise<T>;
  stream(
    path: string,
    body: ModelGatewayRequest,
    signal: AbortSignal,
    credential?: string,
  ): AsyncIterable<ModelGatewayStreamChunk>;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "The teacher server URL must be HTTP or HTTPS without credentials, query, or fragment.",
    );
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "The teacher server URL must be HTTP or HTTPS without credentials, query, or fragment.",
    );
  }
  return new URL(url.origin);
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) {
    throw new Error("The teacher server timeout is invalid.");
  }
  return timeout;
}

function serializeRequest(body: object, maxBytes: number): string {
  const serialized = JSON.stringify(body);
  if (encoder.encode(serialized).byteLength > maxBytes) {
    throw new Error("The teacher server request exceeds its size limit.");
  }
  return serialized;
}

function endpointUrl(baseUrl: URL, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 256) {
    throw new Error("A teacher server endpoint path is invalid.");
  }
  const endpoint = new URL(path, baseUrl);
  if (
    endpoint.origin !== baseUrl.origin ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new Error("A teacher server endpoint path is invalid.");
  }
  return endpoint.toString();
}

function createRequest(
  baseUrl: URL,
  path: string,
  body: object,
  signal: AbortSignal,
  credential?: string,
  maxBytes = MAX_REQUEST_BYTES,
): Request {
  // A fresh connection per request: Bun re-sends a POST whose reused connection closes
  // mid-response and splices both bodies, which would replay turns and model streams.
  const headers = new Headers({
    accept: "application/json",
    connection: "close",
    "content-type": "application/json",
  });
  if (credential !== undefined) headers.set("authorization", `Bearer ${credential}`);
  return new Request(endpointUrl(baseUrl, path), {
    body: serializeRequest(body, maxBytes),
    headers,
    method: "POST",
    redirect: "error",
    signal,
  });
}

function assertContentType(response: Response, expected: string): void {
  const header = response.headers.get("content-type");
  if (header === null) throw new StudentHttpError(response.status, "response.invalid", false);
  // Both anchored and greedy-to-end variants remove the same parameter suffix.
  // Stryker disable next-line Regex
  const contentType = header.replace(/;.*$/u, "").trim();
  if (contentType !== expected)
    throw new StudentHttpError(response.status, "response.invalid", false);
}

async function readBoundedBody(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<string> {
  const length = response.headers.get("content-length");
  // Number(null) is zero, so deleting this null guard is behaviorally equivalent.
  // Stryker disable next-line ConditionalExpression
  if (length !== null && Number(length) > maxBytes) {
    throw new StudentHttpError(response.status, "response.too-large", false);
  }
  // The client also normalizes the iterator's null-body TypeError; this guard fails earlier.
  // Stryker disable next-line ConditionalExpression
  if (response.body === null)
    throw new StudentHttpError(response.status, "response.invalid", false);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const body: AsyncIterable<Uint8Array> = response.body;
  for await (const chunk of transportBody(body)) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new StudentHttpError(response.status, "response.too-large", false);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Callers normalize a decode failure identically after a missing return; keep it local.
  // Stryker disable BlockStatement
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StudentHttpError(response.status, "response.invalid", false);
  }
  // Stryker restore BlockStatement
}

async function responseError(response: Response): Promise<StudentHttpError> {
  try {
    const parsed = ProtocolErrorResponseSchema.parse(parseJson(await readBoundedBody(response)));
    return new StudentHttpError(
      response.status,
      parsed.error.code,
      parsed.error.retryable,
      parsed.error.code === "run.unavailable" &&
        response.headers.get(CLASS_CONFIGURATION_REQUIRED_HEADER) === "true",
    );
  } catch (error: unknown) {
    if (error instanceof StudentHttpError && error.code === "response.too-large") return error;
  }
  return new StudentHttpError(response.status, "server.error", response.status >= 500);
}

async function fetchResponse(fetchRequest: StudentFetch, request: Request): Promise<Response> {
  try {
    return await fetchRequest(request);
  } catch {
    throw new StudentHttpError(
      0,
      request.signal.aborted ? "request.cancelled" : "transport.unavailable",
      !request.signal.aborted,
    );
  }
}

async function* transportBody(
  body: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    yield* body;
  } catch {
    throw new StudentHttpError(
      0,
      signal?.aborted === true ? "request.cancelled" : "transport.interrupted",
      signal?.aborted !== true,
    );
  }
}

export function createHttpClient(options: StudentHttpOptions): HttpClient {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const fetchRequest = options.fetch ?? fetch;
  const timeout = parseTimeout(options.timeoutMs);
  return Object.freeze({
    async json<T extends { readonly requestId: RequestId }>(
      path: string,
      requestId: RequestId,
      body: object,
      schema: z.ZodType<T>,
      credential?: string,
      maxResponseBytes = MAX_JSON_RESPONSE_BYTES,
      maxRequestBytes = MAX_REQUEST_BYTES,
    ): Promise<T> {
      const response = await fetchResponse(
        fetchRequest,
        createRequest(
          baseUrl,
          path,
          body,
          AbortSignal.timeout(timeout),
          credential,
          maxRequestBytes,
        ),
      );
      if (!response.ok) throw await responseError(response);
      assertContentType(response, "application/json");
      try {
        const parsed = schema.parse(parseJson(await readBoundedBody(response, maxResponseBytes)));
        if (parsed.requestId !== requestId) {
          throw new StudentHttpError(response.status, "response.invalid", false);
        }
        return parsed;
      } catch (error: unknown) {
        if (error instanceof StudentHttpError) throw error;
        throw new StudentHttpError(response.status, "response.invalid", false);
      }
    },
    stream(path: string, body: ModelGatewayRequest, signal: AbortSignal, credential?: string) {
      return streamResponse(
        fetchRequest,
        createRequest(baseUrl, path, body, signal, credential),
        body,
      );
    },
  });
}

async function* streamResponse(
  fetchRequest: StudentFetch,
  request: Request,
  expected: ModelGatewayRequest,
): AsyncGenerator<ModelGatewayStreamChunk> {
  const response = await fetchResponse(fetchRequest, request);
  if (!response.ok) throw await responseError(response);
  assertContentType(response, "application/x-ndjson");
  // The stream catch also normalizes the iterator's null-body TypeError; this guard fails earlier.
  // Stryker disable next-line ConditionalExpression
  if (response.body === null)
    throw new StudentHttpError(response.status, "response.invalid", false);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    const body: AsyncIterable<Uint8Array> = response.body;
    for await (const chunk of transportBody(body, request.signal)) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      // Splice always returns one tail element, so its join separator is unobservable.
      // Stryker disable next-line StringLiteral
      pending = lines.splice(-1).join("");
      for (const line of lines) yield parseStreamLine(line, response.status, expected);
      if (encoder.encode(pending).byteLength > MAX_STREAM_LINE_BYTES) {
        throw new StudentHttpError(response.status, "response.too-large", false);
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) yield parseStreamLine(pending, response.status, expected);
  } catch (error: unknown) {
    if (error instanceof StudentHttpError) throw error;
    throw new StudentHttpError(response.status, "response.invalid", false);
  }
}

function parseStreamLine(
  line: string,
  status: number,
  expected: ModelGatewayRequest,
): ModelGatewayStreamChunk {
  // JSON parsing would also reject an empty line; this guard preserves the canonical error.
  // Stryker disable next-line ConditionalExpression,BlockStatement
  if (line.length === 0) {
    throw new StudentHttpError(status, "response.invalid", false);
  }
  if (encoder.encode(line).byteLength > MAX_STREAM_LINE_BYTES) {
    throw new StudentHttpError(status, "response.too-large", false);
  }
  const parsed = ModelGatewayStreamChunkSchema.parse(parseJson(line));
  if (parsed.requestId !== expected.requestId) {
    throw new StudentHttpError(status, "response.invalid", false);
  }
  return parsed;
}

export function createHttpStudentServer(options: StudentHttpOptions): StudentServer {
  const client = createHttpClient(options);
  const paths = options.paths ?? STUDENT_HTTP_PATHS;
  return Object.freeze({
    async heartbeat(token: RunToken): Promise<void> {
      const requestId = RequestIdSchema.parse(`presence:${crypto.randomUUID()}`);
      await client.json(
        "/v1/runs/presence",
        requestId,
        { requestId },
        z.object({ requestId: RequestIdSchema }).strict(),
        token,
      );
    },
    readSkill: (token: RunToken, request: RunSkillRequest) => {
      const validated = RunSkillRequestSchema.parse(request);
      return client.json(
        paths.readSkill ?? STUDENT_HTTP_PATHS.readSkill,
        validated.requestId,
        validated,
        RunSkillResponseSchema.refine(
          (response) =>
            response.runId === validated.runId &&
            response.snapshotId === validated.snapshotId &&
            response.skill.id === validated.skillId,
        ),
        token,
        MAX_SKILL_RESPONSE_BYTES,
      );
    },
    appendRunEvents: (token: RunToken, request: AppendRunEventsRequest) =>
      client.json(
        paths.appendEvents,
        request.requestId,
        boundedEventDelivery(request),
        AppendRunEventsResponseSchema,
        token,
        MAX_JSON_RESPONSE_BYTES,
        MAX_RUN_EVENTS_REQUEST_BYTES,
      ),
    bootstrap: (
      token: SessionToken,
      request: ClassBootstrapRequest,
    ): Promise<AuthenticationResult<ClassBootstrapOutcome>> =>
      authenticatedJson(() =>
        client.json(
          paths.bootstrap,
          request.requestId,
          request,
          ClassBootstrapOutcomeSchema,
          token,
        ),
      ),
    ...signInMethods(client, paths),
    capabilities: (request: CapabilitiesRequest): Promise<CapabilitiesResponse> =>
      client.json(paths.capabilities, request.requestId, request, CapabilitiesResponseSchema),
    closeRun: (token: RunToken, request: CloseRunRequest): Promise<CloseRunResponse> =>
      client.json(paths.closeRun, request.requestId, request, CloseRunResponseSchema, token),
    closeRunAuthenticated: (
      token: SessionToken,
      request: CloseRunRequest,
    ): Promise<CloseRunResponse> =>
      client.json(paths.closeRun, request.requestId, request, CloseRunResponseSchema, token),
    enroll: (request: EnrollStudentRequest): Promise<EnrollStudentResponse> =>
      client.json(paths.enroll, request.requestId, request, EnrollStudentResponseSchema),
    login: (request: CredentialLoginRequest): Promise<CredentialLoginResponse> =>
      client.json(paths.login, request.requestId, request, CredentialLoginResponseSchema),
    openRun: (token: SessionToken, request: OpenRunRequest): Promise<OpenRunResponse> =>
      client.json(paths.openRun, request.requestId, request, OpenRunResponseSchema, token),
    renewLease: (
      token: SessionToken,
      request: RenewRunLeaseRequest,
    ): Promise<RenewRunLeaseResponse> => {
      const validated = RenewRunLeaseRequestSchema.parse(request);
      return client.json(
        paths.renewLease ?? STUDENT_HTTP_PATHS.renewLease,
        validated.requestId,
        validated,
        RenewRunLeaseResponseSchema,
        token,
      );
    },
  });
}

async function* authorizedModelStream(
  client: HttpClient,
  path: string,
  request: ModelGatewayRequest,
  signal: AbortSignal,
  token: () => Promise<RunToken>,
): AsyncGenerator<ModelGatewayStreamChunk> {
  yield* client.stream(path, request, signal, await token());
}

export function createHttpModelGateway(options: ModelGatewayHttpOptions): MareaModelGateway {
  const client = createHttpClient(options);
  const paths = options.paths ?? STUDENT_HTTP_PATHS;
  return Object.freeze({
    stream: (request: ModelGatewayRequest, signal: AbortSignal) =>
      authorizedModelStream(client, paths.modelGateway, request, signal, options.runToken),
  });
}
