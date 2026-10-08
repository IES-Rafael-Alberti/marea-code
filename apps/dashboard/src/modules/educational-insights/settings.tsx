import { useFormDraft } from "../../forms/use-form-draft.js";
import { useEffect, useRef, useState } from "react";
import * as z from "zod";
import { InsightsSettingsSchema } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { insightsClient } from "./client.js";
import { insightsMessages } from "./messages.js";
const schema = z.object({
  settings: InsightsSettingsSchema,
  revision: z.string(),
  mapConfigured: z.boolean().optional(),
  reportsConfigured: z.boolean().optional(),
});
interface SettingsProps {
  readonly classId: string | null;
  readonly locale: DashboardLocale;
  readonly fetchRequest: DashboardFetch;
}
export function EducationalSettings(props: SettingsProps) {
  return props.classId === null ? null : (
    <SettingsContent key={props.classId} {...props} classId={props.classId} />
  );
}
function SettingsContent({ classId, locale, fetchRequest }: SettingsProps & { classId: string }) {
  const m = insightsMessages(locale);
  const pending = useRef<AbortController | null>(null);
  const [value, setValue] = useState<z.infer<typeof schema> | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState<z.infer<typeof schema> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    pending.current = abort;
    setValue(null);
    setError(false);
    void insightsClient(fetchRequest)(classId, { kind: "settings" }, schema, abort.signal)
      .then((v) => {
        if (!abort.signal.aborted) {
          setValue(v);
          setOriginal(v);
          setDirty(false);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
    };
  }, [classId, fetchRequest]);
  useFormDraft(dirty);
  return (
    <section className="educational-settings">
      <h2>{m.settings}</h2>
      {error && <p role="alert">{m.error}</p>}
      {value !== null && (
        <form
          data-dirty={dirty}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setSaved(false);
            setError(false);
            void insightsClient(fetchRequest)(
              classId,
              { kind: "configure", settings: value.settings, expectedRevision: value.revision },
              schema,
              pending.current?.signal ?? AbortSignal.abort(),
            )
              .then((v) => {
                if (!pending.current?.signal.aborted) {
                  setValue(v);
                  setOriginal(v);
                  setDirty(false);
                  setSaved(true);
                }
              })
              .catch(() => {
                setError(true);
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={value.settings.map}
              disabled={busy}
              onChange={(e) => {
                setDirty(true);
                setSaved(false);
                setValue({
                  ...value,
                  settings: { ...value.settings, map: e.currentTarget.checked },
                });
              }}
            />
            {m.enableMap}
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.settings.adaptive}
              disabled={busy}
              onChange={(e) => {
                setDirty(true);
                setSaved(false);
                setValue({
                  ...value,
                  settings: { ...value.settings, adaptive: e.currentTarget.checked },
                });
              }}
            />
            {m.enableAdaptive}
          </label>
          <p>{m.adaptationNote}</p>
          {value.mapConfigured === false && (
            <p>
              {m.unconfigured}{" "}
              <a href="?view=settings&settings=server&server=features">{m.configureServer}</a>
            </p>
          )}
          <p>
            {value.reportsConfigured ? m.reportsReady : m.reportsMissing}{" "}
            <a href="?view=settings&settings=server&server=features">{m.configureServer}</a>
          </p>
          <div className="server-actions">
            <button disabled={busy || !dirty}>{m.save}</button>
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => {
                setValue(original);
                setDirty(false);
                setSaved(false);
              }}
            >
              {m.discard}
            </button>
            {saved && <span role="status">{m.saved}</span>}
            {dirty && <span role="status">{m.unsaved}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
