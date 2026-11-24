import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

import { unhandledFailureOf } from "./domain-error.boundary.js";

/**
 * One operator-private line per unexpected server failure. It names the route template, never
 * its parameter values, and carries no request body, headers or other request content.
 */
export interface UnhandledErrorRecord {
  readonly component: "teacher-product-http";
  readonly event: "unhandled-error";
  readonly method: string;
  readonly route: string;
  readonly requestId: string;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export type UnhandledErrorSink = (record: UnhandledErrorRecord) => void;

export const writeUnhandledError: UnhandledErrorSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

function describe(error: unknown): Pick<UnhandledErrorRecord, "name" | "message" | "stack"> {
  if (error instanceof Error)
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  return { name: typeof error, message: String(error), stack: null };
}

/** Records the exception behind a generic 500 without changing the response. */
export function unhandledErrorLog(sink: UnhandledErrorSink): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const failure = unhandledFailureOf(context.res);
    if (failure === undefined) return;
    const record: UnhandledErrorRecord = {
      component: "teacher-product-http",
      event: "unhandled-error",
      method: context.req.method,
      route: routePath(context),
      requestId: failure.requestId,
      ...describe(failure.error),
    };
    try {
      sink(record);
    } catch {
      // A failing private sink cannot change the public response.
    }
  };
}
