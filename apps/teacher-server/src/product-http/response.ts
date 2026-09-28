import {
  CURRENT_PROTOCOL_VERSION,
  ProtocolErrorResponseSchema,
  type ProtocolErrorCode,
  type RequestId,
} from "@marea/protocol";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function jsonResponse(
  value: object,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  for (const [name, value_] of new Headers(headers)) responseHeaders.set(name, value_);
  return new Response(JSON.stringify(value), { headers: responseHeaders, status });
}

export function protocolError(
  status: number,
  code: ProtocolErrorCode,
  retryable: boolean,
  requestId?: RequestId,
): Response {
  return jsonResponse(
    ProtocolErrorResponseSchema.parse({
      error: { code, retryable },
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      // Stryker disable next-line ConditionalExpression: JSON omits an optional undefined property.
      ...(requestId === undefined ? {} : { requestId }),
    }),
    status,
  );
}
