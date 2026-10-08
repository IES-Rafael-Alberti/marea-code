import { SecretInput } from "../../forms/secret-input.js";
import type { DashboardLocale } from "../../messages.js";
import type { EditableSettings } from "./client.boundary.js";
import { serverSettingsMessages } from "./messages.js";

import type { ModelCatalog, ModelCatalogs } from "./provider-models.boundary.js";

type Messages = ReturnType<typeof serverSettingsMessages>;
type Provider = EditableSettings["providers"][number];
type Values = Record<string, string>;
const inputTypes = { secret: "password", url: "url", text: "text" } as const;

export function ProviderConnections({
  state,
  connections,
  locale,
  change,
  catalogs = {},
  refresh,
  onboarding = false,
}: {
  onboarding?: boolean;
  catalogs?: ModelCatalogs;
  refresh?: () => void;
  state: EditableSettings;
  connections: Record<string, Values>;
  locale: DashboardLocale;
  change: (next: Record<string, Values>) => void;
}) {
  const m = serverSettingsMessages(locale);
  const used = providersInUse(state);
  return (
    <>
      {!onboarding && (
        <>
          <h3>{m.connectionsStep}</h3>
          <p className="server-help">{m.connectionsHelp}</p>
        </>
      )}
      {state.providers.length === 0 && <p>{m.missing}</p>}
      {state.providers.map((provider) => (
        <ProviderConnection
          key={provider.id}
          onboarding={onboarding}
          provider={provider}
          catalog={catalogs[provider.id]}
          refresh={refresh}
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
  onboarding,
  provider,
  catalog,
  refresh,
  values,
  locked,
  m,
  locale,
  change,
}: {
  onboarding: boolean;
  provider: Provider;
  catalog: ModelCatalog | undefined;
  refresh: (() => void) | undefined;
  values: Values | undefined;
  locked: boolean;
  m: Messages;
  locale: DashboardLocale;
  change: (values: Values | undefined) => void;
}) {
  const connected = values !== undefined;
  const Container = onboarding ? "section" : "details";
  const name = provider.descriptor?.name[locale] ?? provider.id;
  return (
    <Container className="workspace-advanced" open={onboarding ? undefined : connected}>
      {onboarding ? <h2>{name}</h2> : <summary>{name}</summary>}
      {provider.descriptor === null ? (
        <p>{m.unavailable}</p>
      ) : (
        <>
          {!onboarding && (
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
          )}
          {!onboarding && connected && locked && <p className="server-help">{m.inUse}</p>}
          {values && (
            <ConnectionFields
              fields={provider.descriptor.fields}
              values={values}
              secrets={provider.secrets}
              onboarding={onboarding}
              m={m}
              locale={locale}
              change={change}
            />
          )}
          {connected && catalog && (
            <div
              role={catalog.status === "invalid" ? "alert" : "status"}
              className="connection-status"
            >
              {
                m[
                  catalog.status === "ready"
                    ? "modelsReady"
                    : catalog.status === "loading"
                      ? "modelsLoading"
                      : catalog.status === "invalid"
                        ? "modelsInvalid"
                        : "modelsUnavailable"
                ]
              }
              {catalog.status === "ready" && ` (${String(catalog.models.length)})`}
              {catalog.status !== "loading" && (
                <button type="button" onClick={refresh}>
                  {m.modelsRefresh}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Container>
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

function fieldInput(
  field: NonNullable<Provider["descriptor"]>["fields"][number],
  values: Values,
  saved: boolean,
  m: Messages,
  change: (values: Values) => void,
) {
  return {
    autoComplete: "off",
    required: field.required && !saved,
    placeholder: saved ? m.configured : field.defaultValue,
    value: values[field.key] ?? "",
    onChange: (event: import("react").ChangeEvent<HTMLInputElement>) => {
      const next = { ...values };
      if (event.currentTarget.value === "") Reflect.deleteProperty(next, field.key);
      else next[field.key] = event.currentTarget.value;
      change(next);
    },
  };
}

function ConnectionFields({
  fields,
  values,
  secrets,
  onboarding,
  m,
  locale,
  change,
}: {
  fields: NonNullable<Provider["descriptor"]>["fields"];
  values: Values;
  secrets: readonly string[];
  onboarding: boolean;
  m: Messages;
  locale: DashboardLocale;
  change: (values: Values) => void;
}) {
  const render = (field: (typeof fields)[number]) => {
    const saved = secrets.includes(field.key);
    return (
      <label className="server-field" key={field.key}>
        {field.label[locale]}
        {field.kind === "secret" ? (
          <SecretInput
            label={field.label[locale]}
            locale={locale}
            saved={saved}
            {...fieldInput(field, values, saved, m, change)}
          />
        ) : (
          <input type={inputTypes[field.kind]} {...fieldInput(field, values, saved, m, change)} />
        )}
      </label>
    );
  };
  return (
    <>
      {fields.filter((field) => !onboarding || field.required).map(render)}
      {onboarding && fields.some((field) => !field.required) && (
        <details className="connection-options">
          <summary>{m.connectionOptions}</summary>
          {fields.filter((field) => !field.required).map(render)}
        </details>
      )}
    </>
  );
}
