import { parseCookie } from "./dashboard-cookie.js";
import { TeacherDomainError } from "../identity/errors.js";
import type { ProductIdentityService } from "./contracts.js";
import type { Hono, MiddlewareHandler } from "hono";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { protocolError } from "./response.js";

/** The compiled listener upgrades only after this ordinary route authorizes the cookie. */
export function registerLiveRoute(
  app: Hono,
  policy: MiddlewareHandler,
  authenticate: (request: Request) => AuthenticatedIdentity,
): void {
  app.get("/api/v1/dashboard/live", policy, (context) => {
    try {
      authenticate(context.req.raw);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    } catch {
      return protocolError(401, "auth.invalid", false);
    }
  });
}

export function teacherCookieIdentity(
  service: ProductIdentityService,
  cookieName: string,
): (request: Request) => AuthenticatedIdentity {
  return (request) => {
    const identity = service.authenticate(
      parseCookie(request.headers.get("cookie"), cookieName),
    ).identity;
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    return identity;
  };
}
