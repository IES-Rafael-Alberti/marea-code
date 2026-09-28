import { subscribeSessionChanges } from "./modules/sessions/session-live.boundary.js";
import { createSessionsClient } from "./modules/sessions/sessions-client.boundary.js";
import { createNoticeClient } from "./modules/sessions/notice-client.boundary.js";
import "./browser-schema-config.js";
import "./styles.css";
import "./profiles/profiles.css";

import { createActiveRunsClient } from "./modules/active-runs/active-runs-client.boundary.js";
import { startDashboard } from "./start-dashboard.js";
import { createEvaluationClient } from "./modules/evaluation/evaluation-client.boundary.js";
import { createSkillAuthoringClient } from "./modules/skill-authoring/skill-authoring-client.boundary.js";
import { localTeachingClient } from "./modules/teaching/teaching-client.boundary.js";
import { createGovernanceClient } from "./modules/governance/governance-client.boundary.js";
import { createDashboardSessionClient } from "./modules/session/session-client.boundary.js";
import type { DashboardStorage } from "./locale.boundary.js";
import { createUsageHealthAdapters } from "./modules/usage-health-adapters.js";

function browserStorage(): DashboardStorage | undefined {
  let storage: DashboardStorage | undefined;
  try {
    storage = localStorage;
  } catch {
    // Storage can be unavailable even though the browser can render the dashboard.
  }
  return storage;
}

const sessions = { ...createSessionsClient(fetch), subscribe: subscribeSessionChanges };
const notices = createNoticeClient(fetch);
const activeRuns = createActiveRunsClient(fetch);

startDashboard(
  {
    document,
    language: navigator.language,
    languages: navigator.languages,
    storage: browserStorage(),
  },
  activeRuns,
  undefined,
  createEvaluationClient(fetch),
  localTeachingClient,
  createSkillAuthoringClient(fetch),
  createGovernanceClient(fetch),
  createDashboardSessionClient(fetch),
  notices,
  sessions,
  { fetch, sessions, notices, moduleAdapters: createUsageHealthAdapters(fetch) },
);
