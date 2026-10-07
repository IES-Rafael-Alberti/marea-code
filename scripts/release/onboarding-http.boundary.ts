import * as z from "zod";
import { ServerSetupRequestSchema, type ServerSetupRequest } from "@marea/protocol";
import { parseJsonRequest } from "../../apps/teacher-server/src/product-http/request-json.boundary.js";
import { ServerSettingsError } from "../../apps/teacher-server/src/server-settings/contracts.js";

const Input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({
      operation: z.literal("models"),
      providerId: z.string().max(128),
      values: z.record(z.string().max(64), z.string().max(2048)),
    })
    .strict(),
  z.object({ operation: z.literal("finish"), setup: ServerSetupRequestSchema }).strict(),
]);
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface OnboardingHttpOptions {
  readonly origin: () => string;
  readonly token: string;
  readonly assets: (request: Request) => Promise<Response>;
  readonly read: () => object | Promise<object>;
  readonly models: (input: object, signal: AbortSignal) => Promise<object>;
  readonly finish: (
    input: ServerSetupRequest,
    signal: AbortSignal,
  ) => Promise<{ dashboardUrl: string; cookie?: string }>;
}

/** A local bearer capability and exact same-origin POST are both required to configure a school. */
export function onboardingHttp(options: OnboardingHttpOptions) {
  let busy = false;
  let completed = false;
  const json = (body: object, status = 200) => Response.json(body, { status, headers: HEADERS });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== options.origin() || request.headers.get("host") !== url.host)
      return json({ error: "forbidden" }, 403);
    if (url.pathname !== "/setup/api") return options.assets(request);
    if (request.method !== "POST" || url.search !== "") return json({ error: "invalid" }, 405);
    if (
      request.headers.get("origin") !== options.origin() ||
      request.headers.get("authorization") !== `Bearer ${options.token}`
    )
      return json({ error: "forbidden" }, 403);
    const parsed = await parseJsonRequest(request, Input, 65_536);
    if (!parsed.ok) return json({ error: "invalid" }, 400);
    const input = parsed.value;
    if (busy || completed) return json({ error: "busy" }, 409);
    try {
      if (input.operation === "read") return json(await options.read());
      if (input.operation === "models") return json(await options.models(input, request.signal));
      busy = true;
      const response = await options.finish(input.setup, request.signal);
      completed = true;
      const result = json({ dashboardUrl: response.dashboardUrl });
      if (response.cookie !== undefined) result.headers.set("set-cookie", response.cookie);
      return result;
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError ||
            (error instanceof ServerSettingsError && error.status === 400)
              ? "invalid"
              : "unavailable",
        },
        400,
      );
    } finally {
      if (input.operation === "finish") busy = false;
    }
  };
}
