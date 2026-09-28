export type PublicErrorCode =
  | "authentication_failed"
  | "authentication_unavailable"
  | "invalid_content_type"
  | "invalid_request"
  | "internal_error"
  | "request_too_large"
  | "request_target_rejected"
  | "route_not_found";

const ERROR_CONTENT_TYPE = "application/problem+json; charset=utf-8";

export function publicError(
  status: 400 | 401 | 403 | 404 | 413 | 415 | 500 | 503,
  code: PublicErrorCode,
  authenticate = false,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": ERROR_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
  if (authenticate) {
    headers.set("www-authenticate", 'Bearer realm="marea"');
  }
  return new Response(JSON.stringify({ error: { code } }), { headers, status });
}
