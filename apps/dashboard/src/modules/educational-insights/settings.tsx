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
  useEffect(() => {
    const abort = new AbortController();
    pending.current = abort;
    setValue(null);
    setError(false);
    void insightsClient(fetchRequest)(classId, { kind: "settings" }, schema, abort.signal)
      .then((v) => {
        if (!abort.signal.aborted) setValue(v);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => {
      abort.abort();
    };
  }, [classId, fetchRequest]);
  return (
    <details className="educational-settings">
      <summary>{m.settings}</summary>
      {error && <p role="alert">{m.error}</p>}
      {value !== null && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(false);
            void insightsClient(fetchRequest)(
              classId,
              { kind: "configure", settings: value.settings, expectedRevision: value.revision },
              schema,
              pending.current?.signal ?? AbortSignal.abort(),
            )
              .then((v) => {
                if (!pending.current?.signal.aborted) setValue(v);
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
                setValue({
                  ...value,
                  settings: { ...value.settings, adaptive: e.currentTarget.checked },
                });
              }}
            />
            {m.enableAdaptive}
          </label>
          <p>{m.adaptationNote}</p>
          {value.mapConfigured === false && <p>{m.unconfigured}</p>}
          <button disabled={busy}>{m.save}</button>
        </form>
      )}
    </details>
  );
}
