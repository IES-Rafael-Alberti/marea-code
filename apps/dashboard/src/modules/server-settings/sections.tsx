import type { DashboardLocale } from "../../messages.js";

export const SERVER_FEATURES_EVENT = "marea:server-features";
export const serverSections = [
  "models",
  "identities",
  "network",
  "features",
  "limits",
  "traces",
] as const;
export type ServerSection = (typeof serverSections)[number];
const labels = {
  es: [
    "Conexión y modelo",
    "Cuentas del centro",
    "Red e instalación",
    "Modelos de funciones",
    "Costes y límites",
    "Trazas externas",
  ],
  en: [
    "Connection and model",
    "School accounts",
    "Network and installation",
    "Feature models",
    "Costs and limits",
    "External traces",
  ],
  eu: [
    "Konexioa eta modeloa",
    "Ikastetxeko kontuak",
    "Sarea eta instalazioa",
    "Funtzioen modeloak",
    "Kostuak eta mugak",
    "Kanpoko aztarnak",
  ],
};
export function ServerSections({
  value,
  change,
  locale,
}: {
  value: ServerSection;
  change: (next: ServerSection) => void;
  locale: DashboardLocale;
}) {
  return (
    <nav className="settings-subnavigation">
      {serverSections.map((id, index) => (
        <button
          type="button"
          key={id}
          aria-current={value === id ? "page" : undefined}
          onClick={() => {
            change(id);
          }}
        >
          {labels[locale][index]}
        </button>
      ))}
    </nav>
  );
}
