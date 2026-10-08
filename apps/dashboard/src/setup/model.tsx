import type { ServerSetupRequest } from "@marea/protocol";
import type { DashboardLocale } from "../messages.js";
import type { EditableSettings } from "../modules/server-settings/client.boundary.js";
import type { ModelCatalogs } from "../modules/server-settings/provider-models.boundary.js";
import { ModelSettings, initialModelRoute } from "../modules/server-settings/model-settings.js";
import { ProviderConnections } from "../modules/server-settings/provider-connections.js";
import { setupMessages } from "./messages.js";

export function SetupModel({
  settings,
  connections,
  changeConnections,
  edit,
  locale,
  catalogs,
  refresh,
}: {
  settings: EditableSettings;
  connections: Record<string, Record<string, string>>;
  changeConnections: (next: Record<string, Record<string, string>>) => void;
  edit: (next: EditableSettings) => void;
  locale: DashboardLocale;
  catalogs: ModelCatalogs;
  refresh: () => void;
}) {
  const m = setupMessages(locale);
  return (
    <div className="server-settings">
      <p>{m.modelHelp}</p>
      {settings.providers.length > 1 && (
        <label>
          {m.steps[1]}
          <select
            value={settings.route?.providerId ?? ""}
            onChange={(event) => {
              const id = event.currentTarget.value;
              changeConnections({ [id]: {} });
              edit({ ...settings, route: initialModelRoute(id) });
            }}
          >
            <option value="" disabled>
              {m.steps[1]}
            </option>
            {settings.providers.map((item) => (
              <option key={item.id} value={item.id} disabled={item.descriptor === null}>
                {item.descriptor?.name[locale] ?? item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <ProviderConnections
        onboarding
        state={{
          ...settings,
          providers: settings.providers.filter((item) => item.id === settings.route?.providerId),
        }}
        connections={connections}
        change={changeConnections}
        locale={locale}
        catalogs={catalogs}
        refresh={refresh}
      />
      <ModelSettings
        onboarding
        state={settings}
        connections={connections}
        edit={edit}
        locale={locale}
        catalogs={catalogs}
      />
    </div>
  );
}

export function isSetupModelReady(
  route: EditableSettings["route"] | undefined,
  providers: EditableSettings["providers"],
  catalogs: ModelCatalogs,
): route is ServerSetupRequest["route"] {
  if (!route?.budget) return false;
  const provider = providers.find((entry) => entry.id === route.providerId);
  return (
    provider !== undefined &&
    (!provider.supportsModels || catalogs[route.providerId]?.status === "ready")
  );
}
