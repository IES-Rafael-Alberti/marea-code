import type { ProfileRuntime } from "./profiles/profile-shell.js";
import type { SessionsClient } from "./modules/sessions/sessions-client.boundary.js";
import { SessionsController } from "./modules/sessions/sessions-controller.js";
import type { NoticeClient } from "./modules/sessions/notice-client.boundary.js";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { DashboardApp, type DashboardState } from "./dashboard-app.js";
import { EvaluationController } from "./modules/evaluation/evaluation-controller.js";
import { TeachingController } from "./modules/teaching/teaching-controller.js";
import type { TeachingClient } from "./modules/teaching/teaching-contracts.js";
import { SkillAuthoringController } from "./modules/skill-authoring/skill-authoring-controller.js";
import type { SkillAuthoringClient } from "./modules/skill-authoring/skill-authoring-contracts.js";
import type { EvaluationClient } from "./modules/evaluation/evaluation-client.boundary.js";
import type { ActiveRunsClient } from "./modules/active-runs/active-runs-client.boundary.js";
import type { GovernanceClient } from "./modules/governance/governance-contracts.js";
import { GovernanceController } from "./modules/governance/governance-controller.js";
import type { DashboardSessionClient } from "./modules/session/session-client.boundary.js";
import { SessionController } from "./modules/session/session-controller.js";
import {
  readDashboardPreference,
  writeDashboardPreference,
  type DashboardStorage,
} from "./locale.boundary.js";
import { selectLocaleFromPreference, type LocalePreference } from "@marea/i18n";

export interface DashboardBrowser {
  readonly document: Document;
  readonly language: string;
  readonly languages?: readonly string[] | undefined;
  readonly storage?: DashboardStorage | undefined;
}

export type DashboardRootFactory = (container: Element) => Root;

export interface DashboardHandle {
  readonly ready: Promise<void>;
  readonly root: Root;
  dispose(): void;
}

interface DashboardModules {
  readonly workspace: SessionsController | undefined;
  readonly ready: Promise<void>;
  readonly state: () => DashboardState;
  readonly evaluation: EvaluationController | undefined;
  readonly teaching: TeachingController | undefined;
  readonly authoring: SkillAuthoringController | undefined;
  readonly governance: GovernanceController | undefined;
  dispose(): void;
}

export function startDashboard(
  browser: DashboardBrowser,
  activeRuns: ActiveRunsClient,
  createDashboardRoot: DashboardRootFactory = createRoot,
  evaluationClient?: EvaluationClient,
  teachingClient?: TeachingClient,
  skillAuthoringClient?: SkillAuthoringClient,
  governanceClient?: GovernanceClient,
  sessionClient?: DashboardSessionClient,
  noticeClient?: NoticeClient,
  workspaceClient?: SessionsClient,
  profiles?: ProfileRuntime,
): DashboardHandle {
  const container = browser.document.getElementById("root");
  if (container === null) {
    throw new Error("Dashboard root element is missing.");
  }

  let preference: LocalePreference = readDashboardPreference(browser.storage) ?? "automatic";
  let locale = selectLocaleFromPreference(preference, browser.languages ?? [browser.language]);
  let languageSaveWarning = false;
  browser.document.documentElement.lang = locale;

  const root = createDashboardRoot(container);
  const page = new AbortController();
  let modules: DashboardModules | undefined;
  let section = "sessions";
  const render = () => {
    if (page.signal.aborted) return;
    root.render(
      <DashboardApp
        profiles={profiles}
        locale={locale}
        preference={preference}
        languageSaveWarning={languageSaveWarning}
        onPreferenceChange={(next) => {
          if (session !== undefined && session.state.status !== "signed-out") return;
          preference = next;
          locale = selectLocaleFromPreference(next, browser.languages ?? [browser.language]);
          languageSaveWarning = !writeDashboardPreference(browser.storage, next);
          browser.document.documentElement.lang = locale;
          render();
        }}
        navigation={{
          section,
          select(next) {
            section = next;
            render();
          },
        }}
        {...(modules?.workspace === undefined
          ? {}
          : {
              workspace: {
                controller: modules.workspace,
                classes: modules.teaching?.state.classes ?? [],
              },
            })}
        {...(modules === undefined ? {} : { state: modules.state() })}
        {...(modules?.teaching === undefined
          ? {}
          : { teaching: { state: modules.teaching.state, controller: modules.teaching } })}
        {...(modules?.authoring === undefined
          ? {}
          : { authoring: { state: modules.authoring.state, controller: modules.authoring } })}
        {...(modules?.evaluation === undefined
          ? {}
          : { evaluation: { state: modules.evaluation.state, controller: modules.evaluation } })}
        {...(modules?.governance === undefined
          ? {}
          : { governance: { state: modules.governance.state, controller: modules.governance } })}
        {...(session === undefined
          ? {}
          : { session: { state: session.state, controller: session } })}
      />,
    );
  };

  /** Creates and loads every module for the signed-in teacher; disposing cancels their requests. */
  const startModules = (): DashboardModules => {
    const requests = new AbortController();
    const workspace =
      profiles !== undefined || workspaceClient === undefined || noticeClient === undefined
        ? undefined
        : new SessionsController(workspaceClient, noticeClient, render);
    let state: DashboardState = { status: "loading" };
    const evaluation =
      evaluationClient === undefined
        ? undefined
        : new EvaluationController(evaluationClient, render);
    const teaching =
      teachingClient === undefined ? undefined : new TeachingController(teachingClient, render);
    const authoring =
      skillAuthoringClient === undefined
        ? undefined
        : new SkillAuthoringController(skillAuthoringClient, render);
    const governance =
      governanceClient === undefined
        ? undefined
        : new GovernanceController(governanceClient, render);
    const runsReady =
      profiles !== undefined
        ? Promise.resolve()
        : activeRuns.load(requests.signal).then(
            (response) => {
              // Stryker disable next-line StringLiteral: the discriminated union treats the sole remaining state as ready.
              state = { response, status: "ready" };
              render();
            },
            () => {
              state = { status: "failed" };
              render();
            },
          );
    return {
      ready: Promise.all([
        runsReady,
        workspace?.start(),
        teaching?.loadClasses(),
        authoring?.loadClasses(),
        governance?.load(),
      ]).then(() => undefined),
      state: () => state,
      workspace,
      evaluation,
      teaching,
      authoring,
      governance,
      dispose() {
        requests.abort();
        workspace?.dispose();
        evaluation?.dispose();
        teaching?.dispose();
        authoring?.dispose();
        governance?.dispose();
      },
    };
  };

  // Modules exist exactly while a teacher is signed in; signing out discards them and their data.
  const session =
    sessionClient === undefined
      ? undefined
      : new SessionController(sessionClient, (current) => {
          const signedIn = current.status === "signed-in" || current.status === "signing-out";
          if (signedIn && modules === undefined) modules = startModules();
          if (!signedIn && modules !== undefined) {
            modules.dispose();
            modules = undefined;
            section = "sessions";
          }
          render();
        });

  let ready: Promise<void>;
  if (session === undefined) {
    modules = startModules();
    render();
    ready = modules.ready;
  } else {
    render();
    ready = session.check().then(() => modules?.ready);
  }
  return Object.freeze({
    ready,
    root,
    dispose() {
      page.abort();
      session?.dispose();
      modules?.dispose();
      root.unmount();
    },
  });
}
