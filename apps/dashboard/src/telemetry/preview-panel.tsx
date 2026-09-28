import { useEffect, useState } from "react";
import type { DashboardLocale } from "../messages.js";
import type { DashboardFetch } from "../modules/active-runs/active-runs-client.boundary.js";
import { createPreviewClient } from "./preview-client.boundary.js";
import { PreviewController, type PreviewState } from "./preview-controller.js";
import { previewMessages } from "./preview-messages.js";
import "./preview.css";

/** The shell keys this component by class, removing old content before a new scope renders. */
export function PreviewPanel({
  classId,
  locale,
  fetchRequest,
}: {
  readonly classId: string | null;
  readonly locale: DashboardLocale;
  readonly fetchRequest: DashboardFetch;
}) {
  const [state, setState] = useState<PreviewState>({ status: "empty" });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new PreviewController(createPreviewClient(fetchRequest), () => {
      setState(controller.state);
    });
    if (classId !== null) void controller.load(classId);
    return () => {
      controller.dispose();
    };
  }, [classId, fetchRequest, attempt]);
  return (
    <PreviewView
      locale={locale}
      state={state}
      classId={classId}
      refresh={() => {
        retry(attempt + 1);
      }}
    />
  );
}

export function PreviewView({
  locale,
  state,
  classId,
  refresh,
}: {
  readonly locale: DashboardLocale;
  readonly state: PreviewState;
  readonly classId: string | null;
  readonly refresh: () => void;
}) {
  const m = previewMessages(locale);
  return (
    <section className="telemetry-preview" aria-label={m.title}>
      <h2>{m.title}</h2>
      <p>{m.synthetic}</p>
      <p>{m.policy}</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {state.status === "ready" ? (
          <>
            <p>{state.response.enabled ? m.enabled : m.disabled}</p>
            <p>
              {m.destinations}: {state.response.destinationCount}
            </p>
          </>
        ) : (
          <p>{m[state.status]}</p>
        )}
      </div>
      {state.status === "ready" && (
        <>
          <details>
            <summary>{m.sample}</summary>
            {state.response.envelope.attributes.length === 0 && <p>{m.noAttributes}</p>}
            <pre>{JSON.stringify(state.response.envelope, null, 2)}</pre>
          </details>
        </>
      )}
      <button
        type="button"
        disabled={classId === null || state.status === "loading"}
        onClick={refresh}
      >
        {m.refresh}
      </button>
    </section>
  );
}
