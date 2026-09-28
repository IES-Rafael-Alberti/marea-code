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
export function ProfileShell({
  locale,
  classes,
  runtime,
}: {
  readonly locale: DashboardLocale;
  readonly classes: readonly TeachingClassSummary[];
  readonly runtime: ProfileRuntime;
}) {
  const [controller, setController] = useState<ProfileController | null>(null);
  const [, changed] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const [classId, selectClass] = useState<string | null>(null);
  const session = useRef<SessionsController | null>(null);
  const register = useRef((value: SessionsController | null) => {
    session.current = value;
  }).current;
  const m = profileMessages(locale);
  const evidenceAdapters = useMemo(
    () =>
      createReviewedEvidenceAdapters(runtime.fetch, (sourceClass, runId, signal) =>
        openEvidenceSession(session.current, sourceClass, runId, signal, () =>
          window.confirm(m.confirm),
        ),
      ),
    [runtime, m.confirm],
  );
  const educationalAdapters = useMemo(
    () =>
      createEducationalAdapters(runtime.fetch, (sourceClass, runId, signal) =>
        openEvidenceSession(session.current, sourceClass, runId, signal, () =>
          window.confirm(m.confirm),
        ),
      ),
    [runtime, m.confirm],
  );
  const canChange = () => !session.current?.hasUnsavedDrafts || window.confirm(m.confirm);
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
  const modules = controller?.legacy
    ? [legacySession]
    : (preview?.modules.filter((module) => module.enabled) ?? []);
  return (
    <section className="profile-shell">
      <label>
        {m.selectClass}
        <select
          value={classId ?? ""}
          disabled={controller === null || controller.busy}
          onChange={(event) => {
            if (!canChange()) return;
            const next = event.currentTarget.value || null;
            selectClass(next);
            if (controller !== null)
              void controller.select(
                next === null ? { kind: "teacher" } : { kind: "class", classId: next },
              );
          }}
        >
          <option value="">{m.selectClass}</option>
          {classes.map((item) => (
            <option key={item.classId} value={item.classId}>
              {item.displayName}
            </option>
          ))}
        </select>
      </label>
      {modules.some((module) =>
        ["org.marea.module.map", "org.marea.module.progress", "org.marea.module.reports"].includes(
          module.moduleId,
        ),
      ) && (
        <EducationalSettings
          key={`education:${classId ?? "none"}`}
          classId={classId}
          locale={locale}
          fetchRequest={runtime.fetch}
        />
      )}
      <PreviewPanel key={classId} classId={classId} locale={locale} fetchRequest={runtime.fetch} />
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
      {controller === null ? (
        <p role="status">{m.loading}</p>
      ) : (
        <>
          <label>
            {m.scope}
            <select
              value={controller.scope.kind}
              disabled={controller.busy}
              onChange={(event) => {
                if (!canChange()) return;
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
            <ProfileEditor controller={controller} locale={locale} canChange={canChange} />
          )}
          {modules.length === 0 && <p>{m.empty}</p>}
          <div className="profile-layout">
            {modules
              .filter((module) => module.placement.slot === "main")
              .concat(modules.filter((module) => module.placement.slot === "aside"))
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
              )}
          </div>
        </>
      )}
    </section>
  );
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
