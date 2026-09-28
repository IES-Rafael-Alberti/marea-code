import { useEffect, useRef, useState } from "react";
import type { DashboardModuleBinding } from "@marea/plugin-api/browser";
import type { DashboardPlacement } from "@marea/plugin-api";
import type { DashboardLocale } from "../messages.js";
import { activateModuleBinding, moduleFrame } from "./module-presentation.js";

export interface ModuleSelection {
  readonly moduleId: string;
  readonly settings: object;
  readonly placement: DashboardPlacement;
}
/** Adapters validate settings and pair a module's loader with its own domain ports. */
export type ModuleAdapter = (selection: ModuleSelection) => DashboardModuleBinding;
export function ModulePlugin({
  module,
  adapter,
  classId,
  locale,
}: {
  readonly module: ModuleSelection;
  readonly adapter: ModuleAdapter | undefined;
  readonly classId: string | null;
  readonly locale: DashboardLocale;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const settingsKey = JSON.stringify(module.settings);
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const abort = new AbortController();
    setFailed(false);
    const fail = () => {
      abort.abort();
      setFailed(true);
    };
    if (adapter === undefined) return;
    try {
      return activateModuleBinding(adapter(module), target, classId, locale, abort, fail);
    } catch {
      fail();
      return;
    }
    // Layout/theme changes preserve the mounted controller and drafts.
  }, [adapter, module.moduleId, settingsKey, classId, locale, attempt]);
  return moduleFrame(module, element, locale, failed || adapter === undefined, () => {
    retry(attempt + 1);
  });
}
