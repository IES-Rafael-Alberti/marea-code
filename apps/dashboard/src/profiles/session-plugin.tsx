import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { dashboardModuleLoaders } from "@marea/plugin-runtime/browser";
import type { TeachingClassSummary } from "@marea/protocol";
import type { DashboardLocale } from "../messages.js";
import type { SessionsClient } from "../modules/sessions/sessions-client.boundary.js";
import type { NoticeClient } from "../modules/sessions/notice-client.boundary.js";
import { SessionsController } from "../modules/sessions/sessions-controller.js";
import { SessionsModule } from "../modules/sessions/sessions-module.js";
import { activateModuleBinding, moduleFrame } from "./module-presentation.js";
import { bindDashboardModule } from "./typed-module-host.js";
import { profileMessages } from "./profile-messages.js";
import type { ProfileSelection } from "./profile-catalog.js";

export interface SessionPluginPorts {
  readonly sessions: SessionsClient;
  readonly notices: NoticeClient;
}
class ModuleRenderBoundary extends Component<
  { readonly children: ReactNode; readonly failed: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.failed();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
export function SessionPlugin({
  module,
  classId,
  locale,
  classes,
  ports,
  register,
}: {
  readonly module: ProfileSelection;
  readonly classId: string | null;
  readonly locale: DashboardLocale;
  readonly classes: readonly TeachingClassSummary[];
  readonly ports: SessionPluginPorts;
  readonly register: (controller: SessionsController | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const m = profileMessages(locale);
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const abort = new AbortController();
    const fail = () => {
      abort.abort();
      setFailed(true);
    };
    setFailed(false);
    // The session adapter is bound only to its exact generated entry.
    const load = dashboardModuleLoaders["org.marea.module.sessions"];
    if (module.moduleId !== "org.marea.module.sessions") {
      fail();
      return;
    }
    const binding = bindDashboardModule(
      async () => ({ default: (await load()).typedEntry }),
      (environment) => ({
        ...environment,
        settings: module.settings,
        placement: module.placement,
        capabilities: { sessionReview: true as const },
        message: (key) =>
          key === "selectClass" ? m.selectClass : key === "loading" ? m.loading : m.failed,
        navigation: { navigate: () => Promise.resolve(false) },
        data: {
          read: () =>
            Promise.resolve((container: HTMLElement) => {
              const root = createRoot(container);
              const controller = new SessionsController(ports.sessions, ports.notices, () => {
                root.render(
                  <ModuleRenderBoundary failed={fail}>
                    <SessionsModule
                      locale={locale}
                      controller={controller}
                      classes={classes}
                      classSelection={false}
                    />
                  </ModuleRenderBoundary>,
                );
              });
              register(controller);
              void controller.chooseClass(classId).then(() => {
                if (!abort.signal.aborted) void controller.start();
              });
              return () => {
                controller.dispose();
                register(null);
                queueMicrotask(() => {
                  root.unmount();
                });
              };
            }),
        },
      }),
    );
    return activateModuleBinding(binding, target, classId, locale, abort, fail);
    // Placement is presentation-only; changing it must not discard session/review state.
  }, [module.moduleId, classId, locale, ports, register, attempt]);
  return moduleFrame(module, element, locale, failed, () => {
    retry(attempt + 1);
  });
}
