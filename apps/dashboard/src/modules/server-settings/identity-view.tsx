import { useEffect, useState } from "react";
import type { z } from "zod";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { IdentityFields } from "../../setup/identity-fields.js";
import { setupMessages } from "../../setup/messages.js";
import { serverSettingsMessages } from "./messages.js";
import { IdentitySettingsResponse, identityRequest } from "./identity-client.js";
import { useFormDraft } from "../../forms/use-form-draft.js";
import { advanceSettingsRevision, type SettingsRevision } from "./settings-revision.js";

const copy = {
  es: {
    title: "Cuentas del centro",
    saved: "Cambios guardados.",
    restart:
      "Cambios guardados. Reinicia marea-teacher para aplicarlos. Las sesiones abiertas conservan su acceso hasta que caduquen.",
    help: "Aquí conectas las cuentas del centro. En los ajustes de cada clase eliges qué correos y grupos pueden entrar.",
    discard: "Descartar cambios",
  },
  en: {
    title: "School accounts",
    saved: "Changes saved.",
    restart:
      "Changes saved. Restart marea-teacher to apply them. Open sessions retain access until they expire.",
    help: "Connect school accounts here. Choose who may join in each class's address and group settings.",
    discard: "Discard changes",
  },
  eu: {
    title: "Ikastetxeko kontuak",
    saved: "Aldaketak gordeta.",
    restart:
      "Aldaketak gordeta. Berrabiarazi marea-teacher aplikatzeko. Irekitako saioek sarbidea mantentzen dute iraungi arte.",
    help: "Konektatu ikastetxeko kontuak hemen. Klase bakoitzean aukeratu sartzeko helbideak eta taldeak.",
    discard: "Baztertu aldaketak",
  },
};

export function IdentitySettingsView({
  fetchRequest,
  locale,
  revisionChange,
  onSaved,
}: {
  fetchRequest: DashboardFetch;
  locale: DashboardLocale;
  revisionChange?: SettingsRevision | null;
  onSaved?: (change: SettingsRevision) => void;
}) {
  const [state, setState] = useState<z.infer<typeof IdentitySettingsResponse> | null>(null);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempt, retry] = useState(0);
  const [saved, setSaved] = useState(false);
  useFormDraft(dirty);
  const m = serverSettingsMessages(locale);
  const c = copy[locale];
  const accept = (next: z.infer<typeof IdentitySettingsResponse>) => {
    setState(next);
    setValues(
      Object.fromEntries(next.providers.filter((p) => p.configured).map((p) => [p.id, p.values])),
    );
    setDirty(false);
    setError(false);
  };
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError(false);
    void identityRequest(
      fetchRequest,
      { operation: "identity-read" },
      IdentitySettingsResponse,
      abort.signal,
    )
      .then(
        (next) => {
          if (!abort.signal.aborted) accept(next);
        },
        () => {
          if (!abort.signal.aborted) setError(true);
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => {
      abort.abort();
    };
  }, [fetchRequest, attempt]);
  useEffect(() => {
    if (revisionChange) setState((current) => advanceSettingsRevision(current, revisionChange));
  }, [revisionChange]);
  return (
    <section className="identity-settings" aria-busy={busy}>
      <h3>{c.title}</h3>
      <p>{c.help}</p>
      {error && (
        <p role="alert">
          {m.error}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm(m.unsaved)) retry(attempt + 1);
            }}
          >
            {m.reload}
          </button>
        </p>
      )}
      {state && (
        <form
          data-dirty={dirty}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(false);
            setSaved(false);
            void identityRequest(
              fetchRequest,
              { operation: "identity-save", expectedRevision: state.revision, connections: values },
              IdentitySettingsResponse,
              new AbortController().signal,
            )
              .then(
                (next) => {
                  onSaved?.({ before: state.revision, after: next.revision });
                  accept(next);
                  setSaved(true);
                },
                () => {
                  setError(true);
                },
              )
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <fieldset disabled={busy}>
            <IdentityFields
              providers={state.providers}
              secrets={Object.fromEntries(state.providers.map((p) => [p.id, p.secrets]))}
              values={values}
              change={(next) => {
                setValues(next);
                setDirty(true);
                setSaved(false);
              }}
              locale={locale}
              m={setupMessages(locale)}
            />
          </fieldset>
          {state.providers.length === 0 ? (
            <p>{m.missing}</p>
          ) : (
            <div className="server-actions">
              <button disabled={busy || !dirty}>{m.save}</button>
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => {
                  accept(state);
                  setSaved(false);
                }}
              >
                {c.discard}
              </button>
              {dirty && <span role="status">{m.pending}</span>}
            </div>
          )}
          {state.restart && <p role="status">{c.restart}</p>}
          {saved && !state.restart && <p role="status">{c.saved}</p>}
        </form>
      )}
    </section>
  );
}
