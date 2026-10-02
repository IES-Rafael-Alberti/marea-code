import {
  workspaceMessages,
  workspaceSections,
  workspaceSection,
  moduleSection,
  settingsSection,
  settingsSections,
  rememberNavigation,
  rememberedNavigation,
} from "./workspace-navigation.js";
import type { SettingsSection, WorkspaceSection } from "./workspace-navigation.js";
import type { ReactNode } from "react";
import { createEducationalAdapters } from "../modules/educational-insights/adapter.js";
import { EducationalSettings } from "../modules/educational-insights/settings.js";
import "../modules/educational-insights/insights.css";
import { ModulePlugin, type ModuleAdapter } from "./module-plugin.js";
import { PreviewPanel } from "../telemetry/preview-panel.js";
import { createReviewedEvidenceAdapters } from "../modules/reviewed-evidence/adapter.js";
import { openEvidenceSession } from "../modules/reviewed-evidence/navigation.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { dashboardThemeLoaders } from "@marea/plugin-runtime/browser";
import type { TeachingClassSummary } from "@marea/protocol";
import type { DashboardLocale } from "../messages.js";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
import type { SessionsController } from "../modules/sessions/sessions-controller.js";
import { loadProfileCatalog, type ProfileSelection } from "./profile-catalog.js";
import { createProfileClient } from "./profile-client.boundary.js";
import { ProfileController } from "./profile-controller.js";
import { ProfileEditor } from "./profile-editor.js";
import { SessionPlugin, type SessionPluginPorts } from "./session-plugin.js";
import { profileMessages } from "./profile-messages.js";
import { themeProperties } from "./theme.js";

export interface ProfileRuntime extends SessionPluginPorts {
  readonly fetch: DashboardFetch;
  readonly moduleAdapters?: ReadonlyMap<string, ModuleAdapter>;
}
/** Content owned by the teacher workspace; each part is shown in its own settings section. */
export interface WorkspaceSettings {
  readonly classroom?: ReactNode;
  readonly server?: ReactNode;
  readonly administration?: ReactNode;
}
export function ProfileShell({
  locale,
  classes,
  runtime,
  settings = {},
  onClassChange,
  hasClassDrafts = false,
  classBusy = false,
}: {
  readonly locale: DashboardLocale;
  readonly classes: readonly TeachingClassSummary[];
  readonly runtime: ProfileRuntime;
  readonly settings?: WorkspaceSettings;
  readonly onClassChange?: (classId: string) => Promise<void>;
  readonly hasClassDrafts?: boolean;
  readonly classBusy?: boolean;
}) {
  const [controller, setController] = useState<ProfileController | null>(null);
  const [, changed] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const [classId, selectClass] = useState<string | null>(null);
  const [section, setSection] = useState<WorkspaceSection>(() =>
    workspaceSection(rememberedNavigation("view")),
  );
  const [subsection, setSubsection] = useState<SettingsSection>(() =>
    settingsSection(rememberedNavigation("settings")),
  );
  const w = workspaceMessages(locale);
  const navigate = (next: WorkspaceSection, part?: SettingsSection) => {
    setSection(next);
    if (part !== undefined) setSubsection(part);
    rememberNavigation(part === undefined ? { view: next } : { view: next, settings: part });
  };
  const session = useRef<SessionsController | null>(null);
  const register = useRef((value: SessionsController | null) => {
    session.current = value;
  }).current;
  const m = profileMessages(locale);
  const openSession = (sourceClass: string | null, runId: string, signal: AbortSignal) =>
    openEvidenceSession(session.current, sourceClass, runId, signal, () =>
      window.confirm(m.confirm),
    ).then((opened) => {
      if (opened) navigate("sessions");
      return opened;
    });
  const evidenceAdapters = useMemo(
    () => createReviewedEvidenceAdapters(runtime.fetch, openSession),
    [runtime, m.confirm],
  );
  const educationalAdapters = useMemo(
    () =>
      createEducationalAdapters(runtime.fetch, openSession, () => {
        navigate("settings", "server");
      }),
    [runtime, m.confirm],
  );
  // Profile drafts are cached per scope and reconciled on return, so only session notices and the
  // class teaching and skill drafts, which a class change discards, need a decision.
  const canChange = () =>
    !(session.current?.hasUnsavedDrafts === true || hasClassDrafts) || window.confirm(w.discard);
  const canChangeProfile = () => !session.current?.hasUnsavedDrafts || window.confirm(m.confirm);
  const changeClass = async (next: string) => {
    if (
      controller === null ||
      controller.busy ||
      classBusy ||
      !classes.some((item) => item.classId === next) ||
      !canChange()
    )
      return;
    // The selector reflects the decision at once; the class modules then load in the background.
    selectClass(next);
    rememberNavigation({ class: next });
    await Promise.all([onClassChange?.(next), controller.select({ kind: "class", classId: next })]);
  };

  useEffect(() => {
    let active = true;
    let current: ProfileController | undefined;
    setFailed(false);
    void loadProfileCatalog()
      .then((release) => {
        if (!active) return;
        current = new ProfileController(
          createProfileClient(runtime.fetch, release),
          release,
          () => {
            changed((value) => value + 1);
          },
        );
        setController(current);
        void current.select({ kind: "teacher" });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      current?.dispose();
    };
  }, [runtime, attempt]);
  const preview = profilePreview(controller);
  const themeId = preview?.themeId;
  useEffect(() => {
    let active = true;
    const loader =
      Object.entries(dashboardThemeLoaders).find(([id]) => id === themeId)?.[1] ??
      dashboardThemeLoaders["org.marea.theme.marea"];
    void loader()
      .then(({ default: theme }) => {
        if (!active) return;
        for (const [key, value] of Object.entries(themeProperties(theme.tokens)))
          document.documentElement.style.setProperty(key, value);
        document.documentElement.style.colorScheme = theme.manifest.colorScheme;
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [themeId]);
  useEffect(() => {
    // An explicit selection is never replaced; changeClass rechecks readiness and membership.
    if (classId !== null) return;
    const remembered = classes.find((item) => item.classId === rememberedNavigation("class"));
    const selected = remembered ?? (classes.length === 1 ? classes[0] : undefined);
    if (selected !== undefined) void changeClass(selected.classId);
  }, [controller, controller?.busy, classes, classId]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (
        session.current?.hasUnsavedDrafts === true ||
        controller?.dirty === true ||
        hasClassDrafts
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      window.removeEventListener("beforeunload", prevent);
    };
  }, [controller, hasClassDrafts]);
  const { modules, parts, shownPart, missing } = workspaceLayout(
    controller,
    preview,
    section,
    subsection,
    settings.administration !== undefined,
  );
  return (
    <section className="profile-shell">
      <div className="workspace-toolbar">
        <label className="workspace-class">
          <span>{m.selectClass}</span>
          <select
            value={classId ?? ""}
            disabled={classBusy || controller?.busy !== false}
            onChange={(event) => {
              void changeClass(event.currentTarget.value);
            }}
          >
            <option value="" disabled>
              {w.choose}
            </option>
            {classes.map((item) => (
              <option key={item.classId} value={item.classId}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <nav className="workspace-navigation" aria-label={w.navigation}>
          {workspaceSections.map((id) => (
            <button
              type="button"
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                navigate(id);
              }}
            >
              {w[id]}
            </button>
          ))}
        </nav>
      </div>
      {failed && (
        <p role="alert">
          {m.unavailable}
          <button
            onClick={() => {
              retry(attempt + 1);
            }}
          >
            {m.retry}
          </button>
        </p>
      )}
      <div hidden={section !== "settings"} className="workspace-settings">
        <nav className="settings-navigation" aria-label={w.settingsNavigation}>
          {parts.map((id) => (
            <button
              type="button"
              key={id}
              aria-current={shownPart === id ? "page" : undefined}
              onClick={() => {
                navigate("settings", id);
              }}
            >
              {w[id]}
            </button>
          ))}
        </nav>
        <div className="settings-pages">
          <div hidden={shownPart !== "classroom"} className="settings-page">
            <p className="settings-intro">{w.classroomNote}</p>
            {settings.classroom}
            <EducationalSettings
              key={`education:${classId ?? "none"}`}
              classId={classId}
              locale={locale}
              fetchRequest={runtime.fetch}
            />
          </div>
          <div hidden={shownPart !== "server"} className="settings-page">
            <p className="settings-intro">{w.serverNote}</p>
            {settings.server}
          </div>
          <div hidden={shownPart !== "panel"} className="settings-page">
            <p className="settings-intro">{w.panelNote}</p>
            {controller === null ? (
              <p role="status">{m.loading}</p>
            ) : (
              <>
                <details className="workspace-advanced" open>
                  <summary>{w.appearance}</summary>
                  <label>
                    {m.scope}
                    <select
                      value={controller.scope.kind}
                      disabled={controller.busy}
                      onChange={(event) => {
                        if (!canChangeProfile()) return;
                        const next = event.currentTarget.value;
                        void controller.select(
                          next === "teacher" || classId === null
                            ? { kind: "teacher" }
                            : { kind: "class", classId },
                        );
                      }}
                    >
                      <option value="teacher">{m.personal}</option>
                      <option value="class" disabled={classId === null}>
                        {m.classOverride}
                      </option>
                    </select>
                  </label>
                  {controller.legacy ? (
                    <p role="status">{m.legacy}</p>
                  ) : (
                    <ProfileEditor
                      controller={controller}
                      locale={locale}
                      canChange={canChangeProfile}
                    />
                  )}
                </details>
                <details className="workspace-advanced">
                  <summary>{w.diagnostics}</summary>
                  <PreviewPanel
                    key={classId}
                    classId={classId}
                    locale={locale}
                    fetchRequest={runtime.fetch}
                  />
                </details>
              </>
            )}
            <div className="settings-modules">
              {section === "settings" && shownPart === "panel" && renderModules("settings")}
            </div>
          </div>
          {settings.administration !== undefined && (
            <div hidden={shownPart !== "administration"} className="settings-page">
              <p className="settings-intro">{w.administrationNote}</p>
              {settings.administration}
            </div>
          )}
        </div>
      </div>
      {controller === null ? (
        section !== "settings" && <p role="status">{m.loading}</p>
      ) : (
        <>
          {missing && (
            <div className="workspace-empty">
              <p>{w.unavailable}</p>
              <button
                type="button"
                onClick={() => {
                  navigate("settings", "panel");
                }}
              >
                {w.configure}
              </button>
            </div>
          )}
          <div className="workspace-content">
            {(["sessions", "map", "progress", "reports"] as const).map((id) => (
              // Views stay mounted while hidden so drafts and selections survive tab changes.
              <div key={id} hidden={section !== id} className="workspace-view">
                {renderModules(id)}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
  function renderModules(target: WorkspaceSection) {
    return modules
      .filter((module) => module.placement.slot === "main")
      .concat(modules.filter((module) => module.placement.slot === "aside"))
      .filter((module) => moduleSection(module.moduleId) === target)
      .map((module) =>
        module.moduleId === "org.marea.module.sessions" ? (
          <SessionPlugin
            key={module.moduleId}
            module={module}
            classId={classId}
            locale={locale}
            classes={classes}
            ports={runtime}
            register={register}
          />
        ) : (
          <ModulePlugin
            key={module.moduleId}
            module={module}
            adapter={
              educationalAdapters.get(module.moduleId) ??
              evidenceAdapters.get(module.moduleId) ??
              runtime.moduleAdapters?.get(module.moduleId)
            }
            classId={classId}
            locale={locale}
          />
        ),
      );
  }
}

/** Visible modules, settings pages and the empty-view decision for the current navigation. */
function workspaceLayout(
  controller: ProfileController | null,
  preview: ReturnType<typeof profilePreview>,
  section: WorkspaceSection,
  subsection: SettingsSection,
  administration: boolean,
) {
  const modules = controller?.legacy
    ? [legacySession]
    : (preview?.modules.filter((module) => module.enabled) ?? []);
  const parts = settingsSections.filter((id) => id !== "administration" || administration);
  return {
    modules,
    parts,
    shownPart: parts.includes(subsection) ? subsection : "classroom",
    missing:
      section !== "settings" && !modules.some((item) => moduleSection(item.moduleId) === section),
  };
}

function profilePreview(controller: ProfileController | null) {
  const catalog = controller?.catalog;
  if (controller?.current == null || catalog == null) return undefined;
  if (controller.problem === "recovery") return controller.current.effective;
  const inherited = controller.current.personal.value ?? catalog.releaseDefaults;
  return {
    themeId: controller.draft?.themeId ?? inherited.themeId,
    modules: (controller.draft?.modules ?? inherited.modules).filter((module) =>
      catalog.modules.some((item) => item.id === module.moduleId),
    ),
  };
}

/** Only an authenticated explicit legacy-host response enables the pre-profile session view. */
const legacySession: ProfileSelection = {
  moduleId: "org.marea.module.sessions",
  configurationVersion: 1,
  enabled: true,
  placement: { slot: "main", size: "wide" },
  settings: {},
};
