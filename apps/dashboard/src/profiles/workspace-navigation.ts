import type { DashboardLocale } from "../messages.js";

export const workspaceSections = ["sessions", "map", "progress", "reports", "settings"] as const;
export type WorkspaceSection = (typeof workspaceSections)[number];
export function workspaceSection(value: string | null): WorkspaceSection {
  return workspaceSections.find((section) => section === value) ?? "sessions";
}
/** Settings separate what affects one class, the shared server, this teacher's panel and a center. */
export const settingsSections = ["classroom", "server", "panel", "administration"] as const;
export type SettingsSection = (typeof settingsSections)[number];
export function settingsSection(value: string | null): SettingsSection {
  return settingsSections.find((section) => section === value) ?? "classroom";
}
const messages = {
  es: {
    navigation: "Navegación principal",
    settingsNavigation: "Secciones de ajustes",
    sessions: "Sesiones",
    map: "Mapa",
    progress: "Progreso",
    reports: "Informes",
    settings: "Ajustes",
    classroom: "Esta clase",
    classroomNote:
      "Cómo enseña el tutor, qué skills recibe el alumnado y qué herramientas educativas están activas en la clase seleccionada.",
    server: "Servidor",
    serverNote: "Proveedores, modelos y límites compartidos por todas las clases de este servidor.",
    panel: "Mi panel",
    panelNote: "Apariencia y vistas de tu panel, estado del servicio y consumo.",
    administration: "Administración del centro",
    administrationNote:
      "Cuentas, clases y pertenencias del centro. No incluye proveedores ni modelos.",
    appearance: "Apariencia y vistas",
    diagnostics: "Diagnóstico y consumo",
    skills: "Edición de skills",
    choose: "Selecciona una clase para empezar",
    unavailable: "Esta vista no está habilitada en tu panel.",
    configure: "Activar en Mi panel",
    discard: "Hay cambios sin guardar. ¿Quieres descartarlos y cambiar de clase?",
  },
  en: {
    navigation: "Main navigation",
    settingsNavigation: "Settings sections",
    sessions: "Sessions",
    map: "Map",
    progress: "Progress",
    reports: "Reports",
    settings: "Settings",
    classroom: "This class",
    classroomNote:
      "How the tutor teaches, which skills students receive and which educational tools are active in the selected class.",
    server: "Server",
    serverNote: "Providers, models and limits shared by every class on this server.",
    panel: "My dashboard",
    panelNote: "Your dashboard appearance and views, service status and usage.",
    administration: "Center administration",
    administrationNote:
      "Center accounts, classes and memberships. It does not include providers or models.",
    appearance: "Appearance and views",
    diagnostics: "Diagnostics and usage",
    skills: "Skill editing",
    choose: "Select a class to get started",
    unavailable: "This view is not enabled in your dashboard.",
    configure: "Enable in My dashboard",
    discard: "There are unsaved changes. Discard them and switch class?",
  },
  eu: {
    navigation: "Nabigazio nagusia",
    settingsNavigation: "Ezarpenen atalak",
    sessions: "Saioak",
    map: "Mapa",
    progress: "Aurrerapena",
    reports: "Txostenak",
    settings: "Ezarpenak",
    classroom: "Ikasgela hau",
    classroomNote:
      "Tutoreak nola irakasten duen, ikasleek zein skill jasotzen dituzten eta hautatutako ikasgelan zein tresna hezitzaile dauden aktibo.",
    server: "Zerbitzaria",
    serverNote:
      "Zerbitzari honetako ikasgela guztiek partekatzen dituzten hornitzaileak, ereduak eta mugak.",
    panel: "Nire panela",
    panelNote: "Zure panelaren itxura eta ikuspegiak, zerbitzuaren egoera eta kontsumoa.",
    administration: "Ikastetxearen administrazioa",
    administrationNote:
      "Ikastetxeko kontuak, ikasgelak eta kidetzak. Ez ditu hornitzaileak ez ereduak barne hartzen.",
    appearance: "Itxura eta ikuspegiak",
    diagnostics: "Diagnostikoa eta kontsumoa",
    skills: "Skillen edizioa",
    choose: "Hautatu ikasgela bat hasteko",
    unavailable: "Ikuspegi hau ez dago gaituta zure panelean.",
    configure: "Gaitu Nire panelean",
    discard: "Gorde gabeko aldaketak daude. Baztertu eta ikasgela aldatu?",
  },
};
export function workspaceMessages(locale: DashboardLocale) {
  return messages[locale];
}
export function moduleSection(id: string): WorkspaceSection {
  if (id === "org.marea.module.sessions") return "sessions";
  if (id === "org.marea.module.map") return "map";
  if (id === "org.marea.module.progress") return "progress";
  if (id === "org.marea.module.reports") return "reports";
  // Reviewed evidence is learning evidence; health and usage are panel diagnostics.
  if (id === "org.marea.module.reviewed-evidence") return "progress";
  return "settings";
}
/** Reads a navigation parameter; server rendering has no location and starts from defaults. */
export function rememberedNavigation(name: string): string | null {
  return typeof window === "undefined"
    ? null
    : new URL(window.location.href).searchParams.get(name);
}
/** Replaces navigation parameters without adding history entries or touching other parameters. */
export function rememberNavigation(values: Readonly<Record<string, string>>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  window.history.replaceState(window.history.state, "", url);
}
