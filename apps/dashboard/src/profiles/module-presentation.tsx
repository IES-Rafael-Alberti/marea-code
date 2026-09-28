import type { RefObject } from "react";
import type { DashboardModuleBinding } from "@marea/plugin-api/browser";
import type { DashboardLocale } from "../messages.js";
import type { DashboardPlacement } from "@marea/plugin-api";
import { profileMessages } from "./profile-messages.js";

/** Own the asynchronous mount result as well as the lifetime signal. */
export function activateModuleBinding(
  binding: DashboardModuleBinding,
  target: HTMLElement,
  classId: string | null,
  locale: DashboardLocale,
  abort: AbortController,
  failed: () => void,
): () => void {
  let dispose: (() => void) | undefined;
  void binding
    .mount(
      target,
      {
        classId,
        locale,
        signal: abort.signal,
        timeRange: { from: "1970-01-01T00:00:00.000Z", to: new Date().toISOString() },
      },
      failed,
    )
    .then((stop) => {
      dispose = stop;
      if (abort.signal.aborted) stop();
    })
    .catch(() => {
      if (!abort.signal.aborted) failed();
    });
  return () => {
    abort.abort();
    dispose?.();
  };
}
export function moduleFrame(
  module: { readonly placement: DashboardPlacement },
  element: RefObject<HTMLDivElement | null>,
  locale: DashboardLocale,
  failed: boolean,
  retry: () => void,
) {
  const m = profileMessages(locale);
  return (
    <section
      className={`profile-module profile-slot-${module.placement.slot} profile-size-${module.placement.size}`}
    >
      {failed && (
        <p role="alert">
          {m.failed}
          <button onClick={retry}>{m.retry}</button>
        </p>
      )}
      <div ref={element} />
    </section>
  );
}
