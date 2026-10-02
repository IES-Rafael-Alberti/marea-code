import type { DashboardLocale } from "../../messages.js";
import type { EditableSettings } from "./client.boundary.js";
import { serverSettingsMessages } from "./messages.js";

type Messages = ReturnType<typeof serverSettingsMessages>;
type Provider = EditableSettings["providers"][number];
type Values = Record<string, string>;
const inputTypes = { secret: "password", url: "url", text: "text" } as const;

export function ProviderConnections({
  state,
  connections,
  locale,
  change,
}: {
  state: EditableSettings;
  connections: Record<string, Values>;
  locale: DashboardLocale;
  change: (next: Record<string, Values>) => void;
}) {
  const m = serverSettingsMessages(locale);
  const used = providersInUse(state);
  return (
    <>
      <h3>{m.connectionsStep}</h3>
      <p className="server-help">{m.connectionsHelp}</p>
      {state.providers.length === 0 && <p>{m.missing}</p>}
      {state.providers.map((provider) => (
        <ProviderConnection
          key={provider.id}
          provider={provider}
          values={connections[provider.id]}
          locked={used.has(provider.id)}
          m={m}
          locale={locale}
          change={(values) => {
            const next = { ...connections };
            if (values === undefined) Reflect.deleteProperty(next, provider.id);
            else next[provider.id] = values;
            change(next);
          }}
        />
      ))}
    </>
  );
}

function ProviderConnection({
  provider,
  values,
  locked,
  m,
  locale,
  change,
}: {
  provider: Provider;
  values: Values | undefined;
  locked: boolean;
  m: Messages;
  locale: DashboardLocale;
  change: (values: Values | undefined) => void;
}) {
  const connected = values !== undefined;
  return (
    <details className="workspace-advanced" open={connected}>
      <summary>{provider.descriptor?.name[locale] ?? provider.id}</summary>
      {provider.descriptor === null ? (
        <p>{m.unavailable}</p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={connected}
              disabled={connected && locked}
              onChange={(event) => {
                change(event.currentTarget.checked ? { ...provider.values } : undefined);
              }}
            />
            {m.connect}
          </label>
          {connected && locked && <p className="server-help">{m.inUse}</p>}
          {values &&
            provider.descriptor.fields.map((field) => {
              // A saved secret is never sent back: an empty field keeps the stored value.
              const saved = provider.secrets.includes(field.key);
              return (
                <label className="server-field" key={field.key}>
                  {field.label[locale]}
                  <input
                    type={inputTypes[field.kind]}
                    autoComplete="off"
                    required={field.required && !saved}
                    placeholder={saved ? m.configured : field.defaultValue}
                    value={values[field.key] ?? ""}
                    onChange={(event) => {
                      const next = { ...values };
                      if (event.currentTarget.value === "") Reflect.deleteProperty(next, field.key);
                      else next[field.key] = event.currentTarget.value;
                      change(next);
                    }}
                  />
                </label>
              );
            })}
        </>
      )}
    </details>
  );
}

/** Connections that the common route, a task route or an imported class route still resolves. */
function providersInUse(state: EditableSettings): ReadonlySet<string> {
  const routes = [state.route, ...state.legacyRoutes.map((item) => item.route)]
    .filter((route) => route !== null)
    .flatMap((route) => [route.providerId, route.evaluation?.providerId ?? route.providerId]);
  const tasks = [state.education.map, state.education.reports]
    .filter((task) => task !== undefined)
    .map((task) => task.providerId);
  return new Set([...routes, ...tasks]);
}
