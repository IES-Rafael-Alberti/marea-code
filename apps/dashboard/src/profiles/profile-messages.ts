import { insightsMessages } from "../modules/educational-insights/messages.js";
import type { DashboardLocale } from "../messages.js";
const en = {
  legacy: "Dashboard customization requires an offline server upgrade. Sessions remain available.",
  title: "Dashboard appearance",
  personal: "Personal defaults",
  classOverride: "My class view",
  theme: "Theme",
  inheritTheme: "Inherit personal theme",
  inheritModules: "Inherit personal modules",
  visible: "Visible",
  up: "Move up",
  down: "Move down",
  slot: "Position",
  size: "Size",
  main: "Main",
  aside: "Aside",
  compact: "Compact",
  standard: "Standard",
  wide: "Wide",
  save: "Save",
  reset: "Reset this scope",
  read: "Read current state",
  accept: "Accept current state",
  reapply: "Keep draft against current revision",
  discard: "Saving discards unavailable plugin settings",
  selectClass: "Select a class",
  loading: "Loading…",
  failed: "Module unavailable. Retry loading.",
  empty: "No visible modules. Use dashboard appearance to enable them.",
  retry: "Retry",
  sessions: "Sessions and evaluation",
  evidence: "Reviewed evidence",
  usage: "Usage and cost",
  health: "Service health",
  marea: "Marea",
  contrast: "High contrast",
  conflict:
    "The profile changed elsewhere. Your draft is retained. Review current state before saving.",
  uncertain:
    "The save could not be confirmed. Readback does not replay the write. Review before continuing.",
  catalog:
    "This page uses a different plugin release. Your draft is retained. Reload the page after recording your draft.",
  unavailable: "Dashboard preferences are unavailable. Your draft is retained. Retry reading.",
  recovery: "This profile needs recovery. Reset this scope to restore inherited defaults.",
  invalid: "Choose a theme or module override, or reset the scope to inherit both fields.",
  warning: "Some saved preferences are unavailable. Replacing this scope discards those settings.",
  matched: "The current saved value matches your draft.",
  confirm: "Leave this session and discard its unsaved review or notice?",
  confirmReset: "Reset this profile scope?",
  scope: "Edit profile",
  draft: "Unsaved profile draft",
};
const es: typeof en = {
  legacy:
    "La personalización del panel requiere actualizar el servidor sin conexión. Las sesiones siguen disponibles.",
  title: "Aspecto del panel",
  personal: "Preferencias personales",
  classOverride: "Mi vista de clase",
  theme: "Tema",
  inheritTheme: "Heredar tema personal",
  inheritModules: "Heredar módulos personales",
  visible: "Visible",
  up: "Subir",
  down: "Bajar",
  slot: "Posición",
  size: "Tamaño",
  main: "Principal",
  aside: "Lateral",
  compact: "Compacto",
  standard: "Estándar",
  wide: "Amplio",
  save: "Guardar",
  reset: "Restablecer este ámbito",
  read: "Leer estado actual",
  accept: "Aceptar estado actual",
  reapply: "Conservar borrador sobre la revisión actual",
  discard: "Guardar descarta los ajustes de complementos no disponibles",
  selectClass: "Selecciona una clase",
  loading: "Cargando…",
  failed: "Módulo no disponible. Reintenta la carga.",
  empty: "No hay módulos visibles. Actívalos en el aspecto del panel.",
  retry: "Reintentar",
  sessions: "Sesiones y evaluación",
  evidence: "Evidencias revisadas",
  usage: "Uso y coste",
  health: "Estado del servicio",
  marea: "Marea",
  contrast: "Alto contraste",
  conflict:
    "El perfil cambió en otra pestaña. Se conserva tu borrador. Revisa el estado actual antes de guardar.",
  uncertain:
    "No se pudo confirmar el guardado. La consulta no repite la escritura. Revisa antes de continuar.",
  catalog:
    "Esta página usa otra versión de complementos. Se conserva tu borrador. Recarga después de anotar el borrador.",
  unavailable:
    "Las preferencias del panel no están disponibles. Se conserva tu borrador. Reintenta la consulta.",
  recovery:
    "Este perfil necesita recuperación. Restablece este ámbito para recuperar las preferencias heredadas.",
  invalid: "Elige un tema o módulos propios, o restablece el ámbito para heredar ambos campos.",
  warning:
    "Algunas preferencias guardadas no están disponibles. Sustituir este ámbito descarta esos ajustes.",
  matched: "El valor guardado actual coincide con tu borrador.",
  confirm: "¿Salir de esta sesión y descartar su revisión o aviso sin guardar?",
  confirmReset: "¿Restablecer este ámbito del perfil?",
  scope: "Editar perfil",
  draft: "Borrador de perfil sin guardar",
};
const eu: typeof en = {
  legacy:
    "Panela pertsonalizatzeko zerbitzaria lineaz kanpo eguneratu behar da. Saioak erabilgarri daude.",
  title: "Panelaren itxura",
  personal: "Hobespen pertsonalak",
  classOverride: "Nire ikasgelako ikuspegia",
  theme: "Gaia",
  inheritTheme: "Gai pertsonala heredatu",
  inheritModules: "Modulu pertsonalak heredatu",
  visible: "Ikusgai",
  up: "Gora",
  down: "Behera",
  slot: "Kokapena",
  size: "Tamaina",
  main: "Nagusia",
  aside: "Albokoa",
  compact: "Trinkoa",
  standard: "Estandarra",
  wide: "Zabala",
  save: "Gorde",
  reset: "Eremu hau berrezarri",
  read: "Uneko egoera irakurri",
  accept: "Uneko egoera onartu",
  reapply: "Zirriborroa uneko berrikuspenarekin mantendu",
  discard: "Gordetzeak erabilgarri ez dauden pluginen ezarpenak baztertzen ditu",
  selectClass: "Hautatu ikasgela",
  loading: "Kargatzen…",
  failed: "Modulua ez dago erabilgarri. Saiatu berriro kargatzen.",
  empty: "Ez dago modulu ikusgairik. Gaitu panelaren itxuran.",
  retry: "Saiatu berriro",
  sessions: "Saioak eta ebaluazioa",
  evidence: "Berrikusitako ebidentziak",
  usage: "Erabilera eta kostua",
  health: "Zerbitzuaren egoera",
  marea: "Marea",
  contrast: "Kontraste handia",
  conflict:
    "Profila beste leku batean aldatu da. Zirriborroa mantendu da. Berrikusi uneko egoera gorde aurretik.",
  uncertain:
    "Ezin izan da gordetzea baieztatu. Irakurketak ez du idazketa errepikatzen. Berrikusi jarraitu aurretik.",
  catalog:
    "Orri honek beste plugin-bertsio bat erabiltzen du. Zirriborroa mantendu da. Berriz kargatu zirriborroa apuntatu ondoren.",
  unavailable:
    "Panelaren hobespenak ez daude erabilgarri. Zirriborroa mantendu da. Saiatu berriro irakurtzen.",
  recovery:
    "Profil hau berreskuratu behar da. Berrezarri eremua heredatutako hobespenak berreskuratzeko.",
  invalid: "Hautatu gai edo modulu propioak, edo berrezarri eremua bi eremuak heredatzeko.",
  warning:
    "Gordetako hobespen batzuk ez daude erabilgarri. Eremua ordezteak ezarpen horiek baztertzen ditu.",
  matched: "Gordetako uneko balioa zirriborroarekin bat dator.",
  confirm: "Saiotik irten eta gorde gabeko berrikuspena edo oharra baztertu?",
  confirmReset: "Profil-eremu hau berrezarri?",
  scope: "Profila editatu",
  draft: "Gorde gabeko profil-zirriborroa",
};
export function profileMessages(locale: DashboardLocale) {
  return {
    ...{ en, es, eu }[locale],
    map: insightsMessages(locale).map,
    progress: insightsMessages(locale).progress,
    reports: insightsMessages(locale).reports,
  };
}

const MODULE_LABELS = {
  "org.marea.module.map": "map",
  "org.marea.module.progress": "progress",
  "org.marea.module.reports": "reports",
  "org.marea.module.sessions": "sessions",
  "org.marea.module.usage": "usage",
  "org.marea.module.health": "health",
  "org.marea.module.reviewed-evidence": "evidence",
} as const;
/** Bundled modules have localized names; any other authorized module is named by its ID. */
export function moduleLabel(m: ReturnType<typeof profileMessages>, moduleId: string): string {
  const key = Object.entries(MODULE_LABELS).find(([id]) => id === moduleId)?.[1];
  return key === undefined ? moduleId : m[key];
}
