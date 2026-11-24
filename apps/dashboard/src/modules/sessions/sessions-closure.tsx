import type { ClassSessionItem } from "@marea/protocol";
import type { Locale } from "@marea/i18n";

import { EndClassSessionsControl, EndSessionControl } from "../run-closure/run-closure-controls.js";
import type { SessionsController } from "./sessions-controller.js";

/** Ends exactly the open sessions currently listed for the chosen class. */
export function ClassClosure({
  controller,
  locale,
  classId,
  runs,
}: {
  readonly controller: SessionsController;
  readonly locale: Locale;
  readonly classId: string | null;
  readonly runs: readonly ClassSessionItem[];
}) {
  const closures = controller.closures;
  if (closures === undefined || classId === null) return null;
  return (
    <EndClassSessionsControl
      client={closures}
      locale={locale}
      classId={classId}
      runs={runs.filter((run) => run.state === "active")}
      onClosed={() => {
        void controller.refresh();
      }}
    />
  );
}

/** Ends the selected session while it is still open. */
export function SelectedClosure({
  controller,
  locale,
  selected,
}: {
  readonly controller: SessionsController;
  readonly locale: Locale;
  readonly selected: ClassSessionItem | null;
}) {
  const closures = controller.closures;
  if (closures === undefined || selected?.state !== "active") return null;
  return (
    <EndSessionControl
      key={selected.runId}
      client={closures}
      locale={locale}
      run={selected}
      onClosed={() => {
        void controller.refresh();
      }}
    />
  );
}
