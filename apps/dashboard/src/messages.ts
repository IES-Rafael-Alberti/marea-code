import { parseLocale, selectLocale, type Locale } from "@marea/i18n";
export type DashboardLocale = Locale;
export interface DashboardMessages {
  readonly activeRunsHeading: string;
  readonly activeRunsLoading: string;
  readonly activeRunsError: string;
  readonly activeRunsEmpty: string;
  readonly approvalPending: string;
  readonly classLabel: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly lastActivityLabel: string;
  readonly projectLabel: string;
  readonly studentLabel: string;
  readonly languageLabel: string;
  readonly languageOptions: Readonly<{
    readonly automatic: string;
    readonly es: string;
    readonly en: string;
    readonly eu: string;
  }>;
  readonly languageSaveFailed: string;
  readonly mainNavigation: string;
  readonly navigation: Readonly<{
    readonly sessions: string;
    readonly teaching: string;
    readonly skills: string;
    readonly administration: string;
  }>;
}
const en = Object.freeze({
  activeRunsHeading: "Active sessions",
  activeRunsLoading: "Loading active sessions",
  activeRunsError: "Active sessions could not be loaded",
  activeRunsEmpty: "Waiting for active sessions",
  approvalPending: "Approval pending",
  classLabel: "Class",
  eyebrow: "Teacher dashboard",
  heading: "Class activity",
  lastActivityLabel: "Last activity",
  projectLabel: "Project",
  studentLabel: "Student",
  languageLabel: "Interface language",
  languageOptions: Object.freeze({
    automatic: "Automatic",
    es: "Castellano",
    en: "English",
    eu: "Euskara",
  }),
  languageSaveFailed:
    "The interface language could not be saved. It is active for this session only.",
  mainNavigation: "Main navigation",
  navigation: Object.freeze({
    sessions: "Sessions",
    teaching: "Teaching",
    skills: "Skills",
    administration: "Administration",
  }),
} satisfies DashboardMessages);
const es = Object.freeze({
  activeRunsHeading: "Sesiones activas",
  activeRunsLoading: "Cargando sesiones activas",
  activeRunsError: "No se han podido cargar las sesiones activas",
  activeRunsEmpty: "Esperando sesiones activas",
  approvalPending: "Aprobación pendiente",
  classLabel: "Clase",
  eyebrow: "Panel docente",
  heading: "Actividad de clase",
  lastActivityLabel: "Última actividad",
  projectLabel: "Proyecto",
  studentLabel: "Estudiante",
  languageLabel: "Idioma de la interfaz",
  languageOptions: Object.freeze({
    automatic: "Automático",
    es: "Castellano",
    en: "English",
    eu: "Euskara",
  }),
  languageSaveFailed:
    "No se ha podido guardar el idioma de la interfaz. Solo estará activo durante esta sesión.",
  mainNavigation: "Navegación principal",
  navigation: Object.freeze({
    sessions: "Sesiones",
    teaching: "Enseñanza",
    skills: "Skills",
    administration: "Administración",
  }),
} satisfies DashboardMessages);
const eu = Object.freeze({
  activeRunsHeading: "Saio aktiboak",
  activeRunsLoading: "Saio aktiboak kargatzen",
  activeRunsError: "Ezin izan dira saio aktiboak kargatu",
  activeRunsEmpty: "Saio aktiboen zain",
  approvalPending: "Baimenaren zain",
  classLabel: "Ikasgela",
  eyebrow: "Irakaslearen panela",
  heading: "Ikasgelako jarduera",
  lastActivityLabel: "Azken jarduera",
  projectLabel: "Proiektua",
  studentLabel: "Ikaslea",
  languageLabel: "Interfazearen hizkuntza",
  languageOptions: Object.freeze({
    automatic: "Automatikoa",
    es: "Castellano",
    en: "English",
    eu: "Euskara",
  }),
  languageSaveFailed:
    "Ezin izan da interfazearen hizkuntza gorde. Saio honetan bakarrik egongo da aktibo.",
  mainNavigation: "Nabigazio nagusia",
  navigation: Object.freeze({
    sessions: "Saioak",
    teaching: "Irakaskuntza",
    skills: "Skill-ak",
    administration: "Administrazioa",
  }),
} satisfies DashboardMessages);
const CATALOGS: Readonly<Record<Locale, DashboardMessages>> = Object.freeze({ en, es, eu });
export function selectDashboardLocale(language: string): DashboardLocale {
  return parseLocale(language) ?? selectLocale(language);
}
export function getDashboardMessages(locale: DashboardLocale): DashboardMessages {
  return locale === "en" ? CATALOGS.en : locale === "eu" ? CATALOGS.eu : CATALOGS.es;
}
