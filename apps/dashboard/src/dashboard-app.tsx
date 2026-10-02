import { TeacherWorkspace } from "./profiles/teacher-workspace.js";
import type { ProfileRuntime } from "./profiles/profile-shell.js";
import {
  SessionsModule,
  type SessionsModuleProperties,
} from "./modules/sessions/sessions-module.js";
import type { ReactElement } from "react";
import type { ActiveRunDashboardResponse } from "@marea/protocol";
import { parseLocalePreference, type LocalePreference } from "@marea/i18n";

import { getDashboardMessages } from "./messages.js";
import type { DashboardLocale } from "./messages.js";
import { ActiveRunsModule } from "./modules/active-runs/active-runs-module.js";
import { TeachingModule } from "./modules/teaching/teaching-module.js";
import type { TeachingModuleProperties } from "./modules/teaching/teaching-contracts.js";
import { SkillAuthoringModule } from "./modules/skill-authoring/skill-authoring-module.js";
import type { SkillAuthoringModuleProperties } from "./modules/skill-authoring/skill-authoring-contracts.js";
import {
  EvaluationModule,
  type EvaluationModuleProperties,
} from "./modules/evaluation/evaluation-module.js";
import {
  GovernanceModule,
  type GovernanceModuleProperties,
} from "./modules/governance/governance-module.js";
import {
  SessionBar,
  SignInModule,
  type SessionViewProperties,
} from "./modules/session/session-views.js";

export type DashboardState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly response: ActiveRunDashboardResponse };

export interface DashboardAppProperties {
  readonly profiles?: ProfileRuntime | undefined;
  readonly locale: DashboardLocale;
  readonly preference?: LocalePreference;
  readonly onPreferenceChange?: (preference: LocalePreference) => void;
  readonly languageSaveWarning?: boolean;
  readonly navigation?: { readonly section: string; select(section: string): void };
  readonly workspace?: Omit<SessionsModuleProperties, "locale">;
  readonly state?: DashboardState;
  readonly evaluation?: Omit<EvaluationModuleProperties, "locale">;
  readonly teaching?: Omit<TeachingModuleProperties, "locale">;
  readonly authoring?: Omit<SkillAuthoringModuleProperties, "locale">;
  readonly governance?: Omit<GovernanceModuleProperties, "locale">;
  /** When present, the modules render only for a signed-in teacher. */
  readonly session?: Omit<SessionViewProperties, "locale">;
}

export function DashboardApp({
  locale,
  profiles,
  preference = "automatic",
  onPreferenceChange,
  languageSaveWarning = false,
  navigation,
  workspace,
  state = { status: "loading" },
  evaluation,
  teaching,
  authoring,
  governance,
  session,
}: DashboardAppProperties): ReactElement {
  const messages = getDashboardMessages(locale);
  const section = navigation?.section ?? "sessions";
  const tabs = messages.navigation;
  const signIn =
    session === undefined ||
    session.state.status === "signed-in" ||
    session.state.status === "signing-out" ? null : (
      <SignInModule
        locale={locale}
        {...session}
        languageControl={
          <>
            <InterfaceLanguageSelector
              messages={messages}
              preference={preference}
              onChange={onPreferenceChange}
              disabled={session.state.status === "signing-in"}
            />
            {languageSaveWarning && (
              <p className="language-save-warning" role="status">
                {messages.languageSaveFailed}
              </p>
            )}
          </>
        }
      />
    );
  const signedIn = signIn === null;

  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">{messages.eyebrow}</p>
        <h1>Marea Code</h1>
        {session !== undefined && signedIn && (
          <details className="account-menu">
            <summary>{session.state.displayName}</summary>
            <SessionBar locale={locale} {...session} />
          </details>
        )}
      </header>
      {signIn}
      {signedIn && (
        <>
          {profiles !== undefined ? (
            <TeacherWorkspace
              locale={locale}
              profiles={profiles}
              teaching={teaching}
              authoring={authoring}
              governance={governance}
            />
          ) : (
            <>
              <nav className="task-navigation" aria-label={messages.mainNavigation}>
                {Object.entries(tabs)
                  .filter(
                    ([id]) =>
                      id !== "administration" || governance?.state.access?.administrator === true,
                  )
                  .map(([id, label]) => (
                    <button
                      key={id}
                      aria-current={section === id ? "page" : undefined}
                      onClick={() => {
                        navigation?.select(id);
                      }}
                    >
                      {label}
                    </button>
                  ))}
              </nav>
              <div hidden={section !== "sessions"}>
                <SessionPanel
                  locale={locale}
                  workspace={workspace}
                  state={state}
                  evaluation={evaluation}
                />
              </div>
              <div hidden={section !== "teaching"}>
                {teaching !== undefined && <TeachingModule locale={locale} {...teaching} />}
              </div>
              <div hidden={section !== "skills"}>
                {authoring !== undefined && <SkillAuthoringModule locale={locale} {...authoring} />}
              </div>
              <div hidden={section !== "administration"}>
                {governance !== undefined && <GovernanceModule locale={locale} {...governance} />}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}

function InterfaceLanguageSelector({
  messages,
  preference,
  onChange,
  disabled,
}: {
  readonly messages: ReturnType<typeof getDashboardMessages>;
  readonly preference: LocalePreference;
  readonly onChange: ((preference: LocalePreference) => void) | undefined;
  readonly disabled: boolean;
}): ReactElement {
  return (
    <label className="interface-language">
      {messages.languageLabel}
      <select
        aria-label={messages.languageLabel}
        value={preference}
        disabled={disabled}
        onChange={(event) => {
          const next = parseLocalePreference(event.currentTarget.value);
          if (next !== null) onChange?.(next);
        }}
      >
        <option value="automatic">{messages.languageOptions.automatic}</option>
        <option value="es">{messages.languageOptions.es}</option>
        <option value="en">{messages.languageOptions.en}</option>
        <option value="eu">{messages.languageOptions.eu}</option>
      </select>
    </label>
  );
}

/** The pre-profile session surfaces, used only when no profile runtime is composed. */
function SessionPanel({
  locale,
  workspace,
  state,
  evaluation,
}: {
  readonly locale: DashboardLocale;
  readonly workspace: DashboardAppProperties["workspace"];
  readonly state: DashboardState;
  readonly evaluation: DashboardAppProperties["evaluation"];
}) {
  if (workspace !== undefined) return <SessionsModule locale={locale} {...workspace} />;
  return (
    <>
      <ActiveRunsModule locale={locale} messages={getDashboardMessages(locale)} state={state} />
      {evaluation !== undefined && <EvaluationModule locale={locale} {...evaluation} />}
    </>
  );
}
