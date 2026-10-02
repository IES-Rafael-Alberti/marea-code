import { createRoot } from "react-dom/client";
import { dashboardModuleLoaders } from "@marea/plugin-runtime/browser";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { hostViewAdapter } from "../usage-health-adapters.js";
import { InsightView } from "./view.js";
export function createEducationalAdapters(
  fetchRequest: DashboardFetch,
  navigate: (classId: string | null, runId: string, signal: AbortSignal) => Promise<boolean>,
  configure?: () => void,
) {
  return new Map(
    (["map", "progress", "reports"] as const).flatMap((kind) =>
      hostViewAdapter(
        dashboardModuleLoaders,
        `org.marea.module.${kind}`,
        { evaluationRead: true },
        (environment) => (container) => {
          const root = createRoot(container);
          root.render(
            <InsightView
              configure={configure}
              kind={kind}
              classId={environment.classId}
              locale={environment.locale}
              fetchRequest={fetchRequest}
              navigate={(runId) => navigate(environment.classId, runId, environment.signal)}
            />,
          );
          return () => {
            queueMicrotask(() => {
              root.unmount();
            });
          };
        },
      ),
    ),
  );
}
