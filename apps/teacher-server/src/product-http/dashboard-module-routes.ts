import { registerServerSettingsRoutes } from "./server-settings-http.boundary.js";
import { registerSessionExportRoutes } from "./session-export-http.boundary.js";
import { registerEducationalInsightsRoutes } from "./educational-insights-http.boundary.js";
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
  registerServerSettingsRoutes({ ...options, service: options.services.serverSettings });
  registerServerSettingsRoutes({
    ...options,
    service: options.services.observability,
    path: "/api/v1/dashboard/observability",
  });
  registerSessionExportRoutes({ ...options, service: options.services.sessionExport });
  registerEducationalInsightsRoutes({ ...options, service: options.services.educationalInsights });
  registerDashboardProfileRoutes({ ...options, service: options.services.profiles });
  registerUsageHealthRoutes({ ...options, service: options.services.usageHealth });
  registerReviewedEvidenceRoutes({ ...options, service: options.services.reviewedEvidence });
}
