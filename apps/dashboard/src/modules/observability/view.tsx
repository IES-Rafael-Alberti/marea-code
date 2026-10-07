import { useEffect, useState } from "react";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { EvaluationRequestError } from "../evaluation/evaluation-client.boundary.js";
import {
  ObservabilityResponse,
  observabilityRequest,
  type ObservabilityState,
} from "./client.boundary.js";
import { observabilityMessages } from "./messages.js";

export function ObservabilityView({
  locale,
  fetchRequest,
}: {
  locale: DashboardLocale;
  fetchRequest: DashboardFetch;
}) {
  const m = observabilityMessages(locale);
  const [state, setState] = useState<ObservabilityState | null>(null);
  const [pluginId, setPluginId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    "saved" | "tested" | "error" | "conflict" | "unavailable" | null
  >(null);
  const accept = (next: ObservabilityState) => {
    setState(next);
    setPluginId(next.pluginId ?? "");
    setEnabled(next.enabled);
    setValues(next.plugins.find((p) => p.id === next.pluginId)?.values ?? {});
  };
  useEffect(() => {
    const abort = new AbortController();
    void observabilityRequest(fetchRequest, { operation: "read" }, abort.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!abort.signal.aborted) accept(ObservabilityResponse.parse(data));
      })
      .catch(() => {
        if (!abort.signal.aborted) setMessage("unavailable");
      });
    return () => {
      abort.abort();
    };
  }, [fetchRequest]);
  const plugin = state?.plugins.find((p) => p.id === pluginId);
  const perform = async (operation: "save" | "test" | "read" | "retry", revision = 0) => {
    setBusy(true);
    setMessage(null);
    try {
      const body =
        operation === "read" || operation === "retry"
          ? { operation }
          : {
              operation,
              pluginId,
              values,
              ...(operation === "save" ? { enabled, expectedRevision: revision } : {}),
            };
      const response = await observabilityRequest(fetchRequest, body, new AbortController().signal);
      if (operation === "test") setMessage("tested");
      else {
        accept(ObservabilityResponse.parse(await response.json()));
        if (operation === "save") setMessage("saved");
      }
    } catch (error) {
      setMessage(
        error instanceof EvaluationRequestError && error.status === 409 ? "conflict" : "error",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="observability-settings" aria-busy={busy}>
      <h3>{m.title}</h3>
      <p>{m.description}</p>
      <p>{m.privacy}</p>
      {state !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform("save", state.revision);
          }}
        >
          <fieldset disabled={busy}>
            <label>
              {m.destination}
              <select
                value={pluginId}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  setPluginId(id);
                  setEnabled(false);
                  const entry = state.plugins.find((p) => p.id === id);
                  setValues(
                    Object.fromEntries(
                      entry?.descriptor.fields.flatMap((f) => {
                        const v = entry.values[f.key] ?? f.defaultValue;
                        return v === undefined ? [] : [[f.key, v]];
                      }) ?? [],
                    ),
                  );
                }}
              >
                <option value="">{m.choose}</option>
                {state.pluginId !== null && !state.plugins.some((p) => p.id === state.pluginId) && (
                  <option value={state.pluginId}>{m.missing}</option>
                )}
                {state.plugins.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.descriptor.name[locale]}
                  </option>
                ))}
              </select>
            </label>
            {plugin?.descriptor.fields.map((field) => (
              <label key={field.key}>
                {field.label[locale]}
                <input
                  type={
                    field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"
                  }
                  autoComplete="off"
                  value={values[field.key] ?? ""}
                  placeholder={plugin.secrets.includes(field.key) ? m.secret : undefined}
                  required={field.required && !plugin.secrets.includes(field.key)}
                  onChange={(e) => {
                    const next = { ...values };
                    if (field.kind === "secret" && e.currentTarget.value === "")
                      setValues(
                        Object.fromEntries(
                          Object.entries(next).filter(([key]) => key !== field.key),
                        ),
                      );
                    else {
                      next[field.key] = e.currentTarget.value;
                      setValues(next);
                    }
                  }}
                />
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={enabled}
                disabled={plugin === undefined && !enabled}
                onChange={(e) => {
                  setEnabled(e.currentTarget.checked);
                }}
              />
              {m.enabled}
            </label>
            <button type="submit" disabled={!pluginId}>
              {m.save}
            </button>
            <button
              type="button"
              disabled={plugin === undefined}
              onClick={() => {
                void perform("test");
              }}
            >
              {m.test}
            </button>
          </fieldset>
        </form>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void perform("read");
        }}
      >
        {m.refresh}
      </button>
      {state !== null && (
        <>
          <p>{!state.enabled ? m.disabled : !state.status.available ? m.paused : m.active}</p>
          {!state.status.healthy && <p role="alert">{m.health}</p>}
          <p>
            {m.pending}: {state.status.pending} · {m.failed}: {state.status.failed} · {m.sent}:{" "}
            {state.status.sent} · {m.dropped}: {state.status.dropped}
          </p>
          <p>
            {m.last}: {state.status.lastSentAt ?? m.never}
          </p>
          <button
            type="button"
            disabled={busy || state.status.failed === 0}
            onClick={() => {
              void perform("retry");
            }}
          >
            {m.retry}
          </button>
        </>
      )}
      {busy && <p role="status">{m.working}</p>}
      {message !== null && (
        <p role={message === "saved" || message === "tested" ? "status" : "alert"}>{m[message]}</p>
      )}
    </section>
  );
}
