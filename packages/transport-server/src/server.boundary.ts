import { Hono, type MiddlewareHandler } from "hono";

import { authenticationMiddleware, type TransportEnvironment } from "./authentication.js";
import {
  bunWebSocketHandler,
  type BunSocketData,
  type BunUpgradeEnvironment,
} from "./bun-websocket.boundary.js";
import {
  MAX_REQUEST_BYTES,
  type AuthenticatedPrincipal,
  type SessionPort,
  type TransportServerOptions,
} from "./contracts.js";
import { createStreamBody } from "./http-stream.js";
import { validateTransportMounts } from "./mounts.js";
import { publicError } from "./public-errors.js";
import { RequestPolicy } from "./request-policy.js";
import { parseStreamRequest } from "./schemas.boundary.js";
import { createWebSocketEvents } from "./websocket.boundary.js";

const JSON_MEDIA_TYPE = "application/json";
const STREAM_MEDIA_TYPE = "application/x-ndjson; charset=utf-8";
export const MAX_REQUEST_CHUNKS = 256;
export const MAX_CONFIGURABLE_REQUEST_BYTES = 4 * 1_024 * 1_024;

function policyMiddleware(policy: RequestPolicy): MiddlewareHandler<TransportEnvironment> {
  return async (context, next) => {
    if (!policy.evaluate(context.req.raw).allowed) {
      return publicError(403, "request_target_rejected");
    }
    return next();
  };
}

export function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  const separator = contentType.indexOf(";");
  const mediaType = separator === -1 ? contentType : contentType.slice(0, separator);
  return mediaType.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

function expectedContentLength(request: Request, maxBytes: number): number | Response | undefined {
  const header = request.headers.get("content-length");
  if (header === null) {
    return undefined;
  }
  if (!/^\d+$/u.test(header)) {
    return publicError(400, "invalid_request");
  }
  const length = Number(header);
  return length > maxBytes ? publicError(413, "request_too_large") : length;
}

function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {
    // The response decision must not depend on a hostile stream's cancel hook.
  });
}

async function fillRequestBuffer(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bytes: Uint8Array,
  bytesRead: number,
  remainingReads: number,
  maxBytes: number,
): Promise<number | Response> {
  if (remainingReads === 0) {
    cancelBody(reader);
    return publicError(413, "request_too_large");
  }
  const chunk = await reader.read();
  if (chunk.done) {
    return bytesRead;
  }
  const nextSize = bytesRead + chunk.value.byteLength;
  if (nextSize > maxBytes) {
    cancelBody(reader);
    return publicError(413, "request_too_large");
  }
  bytes.set(chunk.value, bytesRead);
  return fillRequestBuffer(reader, bytes, nextSize, remainingReads - 1, maxBytes);
}

export async function readRequest(
  request: Request,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<string | Response> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_CONFIGURABLE_REQUEST_BYTES
  ) {
    throw new TypeError("The request byte limit is invalid.");
  }
  const expectedLength = expectedContentLength(request, maxBytes);
  if (expectedLength instanceof Response) {
    return expectedLength;
  }
  if (request.body === null) {
    return expectedLength === undefined || expectedLength === 0
      ? ""
      : publicError(400, "invalid_request");
  }
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let result: number | Response;
  try {
    result = await fillRequestBuffer(reader, bytes, 0, MAX_REQUEST_CHUNKS, maxBytes);
  } finally {
    reader.releaseLock();
  }
  if (result instanceof Response) {
    return result;
  }
  const bytesRead = result;
  if (expectedLength !== undefined && bytesRead !== expectedLength) {
    return publicError(400, "invalid_request");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } catch {
    return publicError(400, "invalid_request");
  }
}

export function upgradeSession(
  request: Request,
  environment: BunUpgradeEnvironment | undefined,
  principal: AuthenticatedPrincipal,
  sessions: SessionPort,
): Response {
  if (environment === undefined) {
    return publicError(500, "internal_error");
  }
  const data: BunSocketData = {
    events: createWebSocketEvents(principal, sessions),
    protocol: "",
    url: new URL(request.url),
  };
  return environment.upgrade(request, { data })
    ? new Response(null)
    : publicError(500, "internal_error");
}

export function createBunTransport(options: TransportServerOptions) {
  validateTransportMounts(options.mounts.stream, options.mounts.session);
  const policy = new RequestPolicy(options.policy);
  const app = new Hono<TransportEnvironment>();
  const enforcePolicy = policyMiddleware(policy);
  const authenticate = authenticationMiddleware(options.ports.authentication);

  app.post(options.mounts.stream, enforcePolicy, authenticate, async (context) => {
    if (!isJson(context.req.header("content-type"))) {
      return publicError(415, "invalid_content_type");
    }
    const body = await readRequest(context.req.raw);
    if (body instanceof Response) {
      return body;
    }
    const request = parseStreamRequest(body);
    if (!request.ok) {
      return publicError(400, "invalid_request");
    }
    const stream = createStreamBody(
      request.value,
      context.get("principal"),
      options.ports.streams,
      context.req.raw.signal,
    );
    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-type": STREAM_MEDIA_TYPE,
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get(options.mounts.session, enforcePolicy, authenticate, (context) =>
    upgradeSession(context.req.raw, context.env, context.get("principal"), options.ports.sessions),
  );

  app.notFound(() => publicError(404, "route_not_found"));
  app.onError(() => publicError(500, "internal_error"));

  return Object.freeze({ fetch: app.fetch, websocket: bunWebSocketHandler });
}
