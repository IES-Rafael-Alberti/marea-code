import type { Hono, MiddlewareHandler } from "hono";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { TeacherProductServices } from "./contracts.js";
import { registerDashboardProfileRoutes } from "./profile-http.boundary.js";
import { registerReviewedEvidenceRoutes } from "./reviewed-evidence-http.boundary.js";
import { registerUsageHealthRoutes } from "./usage-health-http.boundary.js";

/** Shared teacher policy, with independently authorized profile and projection services. */
export function registerDashboardModuleRoutes(options: {
  readonly app: Hono;
  readonly policy: MiddlewareHandler;
  readonly authenticate: (request: Request) => AuthenticatedIdentity;
  readonly services: TeacherProductServices;
}): void {
  registerDashboardProfileRoutes({ ...options, service: options.services.profiles });
  registerUsageHealthRoutes({ ...options, service: options.services.usageHealth });
  registerReviewedEvidenceRoutes({ ...options, service: options.services.reviewedEvidence });
}
