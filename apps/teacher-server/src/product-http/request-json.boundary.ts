import { isJson, readRequest } from "@marea/transport-server";
import type * as z from "zod";
import { protocolError } from "./response.js";
export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };
const JSON_REQUEST_LIMIT = 64 * 1024;
export async function parseJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = JSON_REQUEST_LIMIT,
): Promise<ParseResult<T>> {
  if (!isJson(request.headers.get("content-type") ?? undefined)) {
    return { ok: false, response: protocolError(415, "request.invalid", false) };
  }
  const text = await readRequest(request, maxBytes);
  if (text instanceof Response) {
    return { ok: false, response: protocolError(text.status, "request.invalid", false) };
  }
  let input: unknown;
  // Stryker disable BlockStatement: Emptying this catch still delegates undefined to the same schema error.
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, response: protocolError(400, "request.invalid", false) };
  }
  // Stryker restore BlockStatement
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, response: protocolError(400, "request.invalid", false) };
}
