import { useEffect, useState } from "react";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import {
  settingsRequest,
  saveSettings,
  type SettingsResponse,
  type EditableSettings,
} from "./client.boundary.js";
import { useProviderModels } from "./provider-models.boundary.js";
import { ProviderConnections } from "./provider-connections.js";
import { ModelSettings } from "./model-settings.js";
import { serverSettingsMessages } from "./messages.js";
import { PreviewInstall } from "./preview-install.js";
import "./settings.css";

export function ServerSettingsView({
  fetchRequest,
  locale,
  classNames,
}: {
  fetchRequest: DashboardFetch;
  locale: DashboardLocale;
  classNames?: Readonly<Record<string, string>> | undefined;
}) {
  const m = serverSettingsMessages(locale);
  const [state, setState] = useState<SettingsResponse | null>(null);
  const [connections, setConnections] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { catalogs, refresh } = useProviderModels(fetchRequest, state, connections);
  const accept = (next: SettingsResponse) => {
    setState(next);
    setConnections(
      next.administrator
        ? Object.fromEntries(
            next.providers.filter((p) => p.configured).map((p) => [p.id, p.values]),
          )
        : {},
    );
    setDirty(false);
  };
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void settingsRequest(fetchRequest, { operation: "read" }, controller.signal)
      .then(
        (next) => {
          if (!controller.signal.aborted) {
            accept(next);
            setError(null);
          }
        },
        () => {
          if (!controller.signal.aborted) setError("unavailable");
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
    };
  }, [fetchRequest, attempt]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      window.removeEventListener("beforeunload", prevent);
    };
  }, [dirty]);
  const edit = (next: EditableSettings) => {
    if (error === "invalid") setError(null);
    setState(next);
    setDirty(true);
    setSaved(false);
  };
  const reload = () => {
    if (!dirty || window.confirm(m.unsaved)) setAttempt(attempt + 1);
  };
  return (
    <section className="dashboard-module server-settings" aria-busy={busy}>
      <h2>{m.title}</h2>
      {state === null ? (
        error === null ? (
          <p>{m.loading}</p>
        ) : (
          <p role="alert">
            {m.error}{" "}
            <button type="button" disabled={busy} onClick={reload}>
              {m.reload}
            </button>
          </p>
        )
      ) : !state.administrator ? (
        <p>{state.initialized ? m.access : m.setup}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || error !== null) return;
            setBusy(true);
            setSaved(false);
            void saveSettings(
              fetchRequest,
              {
                operation: "save",
                expectedRevision: state.revision,
                connections,
                route: state.route,
                education: state.education,
                useCommonRoute: state.useCommonRoute,
              },
              new AbortController().signal,
            )
              .then((result) => {
                if (result.ok) {
                  accept(result.value);
                  setSaved(true);
                } else setError(result.reason);
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <p className="server-role">{m.roleAdmin}</p>
          <fieldset disabled={busy}>
            <ProviderConnections
              refresh={refresh}
              state={state}
              catalogs={catalogs}
              connections={connections}
              locale={locale}
              change={(next) => {
                if (error === "invalid") setError(null);
                setConnections(next);
                setDirty(true);
                setSaved(false);
              }}
            />
            <ModelSettings
              state={state}
              catalogs={catalogs}
              connections={connections}
              locale={locale}
              edit={edit}
              classNames={classNames}
            />
          </fieldset>
          <SettingsActions
            m={m}
            busy={busy}
            dirty={dirty}
            saved={saved}
            error={error}
            reload={reload}
          />
        </form>
      )}
      {state?.administrator === true && (
        <PreviewInstall locale={locale} origins={state.connectionOrigins} />
      )}
    </section>
  );
}

/** Save and reload stay together with the outcome of the last action, visible while scrolling. */
function SettingsActions({
  m,
  busy,
  dirty,
  saved,
  error,
  reload,
}: {
  m: ReturnType<typeof serverSettingsMessages>;
  busy: boolean;
  dirty: boolean;
  saved: boolean;
  error: string | null;
  reload: () => void;
}) {
  const problem = error === "conflict" ? m.conflict : error === "invalid" ? m.invalid : m.error;
  return (
    <div className="server-actions">
      <button type="submit" disabled={busy || !dirty || error !== null}>
        {m.save}
      </button>
      <button type="button" disabled={busy} onClick={reload}>
        {m.reload}
      </button>
      {error !== null ? (
        <span role="alert">{problem}</span>
      ) : saved ? (
        <span role="status">{m.saved}</span>
      ) : (
        dirty && <span role="status">{m.pending}</span>
      )}
    </div>
  );
}
