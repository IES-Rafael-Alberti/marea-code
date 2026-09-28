import { dashboardModuleLoaders } from "@marea/plugin-runtime/browser";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import {
  hostViewAdapter,
  reactView,
  type DashboardModuleLoaders,
} from "../usage-health-adapters.js";
import { createReviewedEvidenceClient } from "./client.boundary.js";
import { ReviewedEvidenceController } from "./controller.js";
import { ReviewedEvidenceView } from "./view.js";

export function createReviewedEvidenceAdapters(
  fetchRequest: DashboardFetch,
  navigate: (classId: string | null, runId: string, signal: AbortSignal) => Promise<boolean>,
  loaders: DashboardModuleLoaders = dashboardModuleLoaders,
) {
  const port = createReviewedEvidenceClient(fetchRequest);
  return new Map(
    hostViewAdapter(
      loaders,
      "org.marea.module.reviewed-evidence",
      { evaluationRead: true },
      (environment) =>
        reactView(
          environment,
          (changed) => new ReviewedEvidenceController(port, changed),
          (controller) => (
            <ReviewedEvidenceView
              locale={environment.locale}
              controller={controller}
              openSession={(runId) => navigate(environment.classId, runId, environment.signal)}
            />
          ),
        ),
    ),
  );
}
