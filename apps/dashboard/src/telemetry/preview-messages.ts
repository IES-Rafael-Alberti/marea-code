import type { DashboardLocale } from "../messages.js";
const en = {
  title: "Telemetry preview",
  synthetic: "Synthetic sample only. This is not historical data or evidence of an export.",
  policy:
    "Operational data only. Student content and identifiers are omitted; text values are redacted. This preview does not send telemetry or grant consent.",
  empty: "Select a class to preview the policy.",
  loading: "Loading telemetry preview…",
  error: "Telemetry preview is unavailable. Try again.",
  denied: "Access denied. Sign in again or select an authorized class.",
  refresh: "Refresh preview",
  enabled: "Telemetry enabled",
  disabled: "Telemetry disabled",
  destinations: "Configured destinations",
  sample: "Redacted synthetic envelope",
  noAttributes: "No attributes in this sample.",
};
const es: typeof en = {
  title: "Vista previa de telemetría",
  synthetic: "Muestra sintética. No son datos históricos ni prueba de un envío.",
  policy:
    "Solo datos operativos. Se omiten el contenido del alumnado y los identificadores; los valores de texto se ocultan. Esta vista previa no envía telemetría ni otorga consentimiento.",
  empty: "Selecciona una clase para ver la política.",
  loading: "Cargando vista previa de telemetría…",
  error: "La vista previa de telemetría no está disponible. Inténtalo de nuevo.",
  denied: "Acceso denegado. Inicia sesión de nuevo o selecciona una clase autorizada.",
  refresh: "Actualizar vista previa",
  enabled: "Telemetría activada",
  disabled: "Telemetría desactivada",
  destinations: "Destinos configurados",
  sample: "Muestra sintética con datos ocultados",
  noAttributes: "No hay atributos en esta muestra.",
};
const eu: typeof en = {
  title: "Telemetriaren aurrebista",
  synthetic: "Lagin sintetikoa soilik. Ez dira datu historikoak, ezta bidalketa baten froga ere.",
  policy:
    "Datu operatiboak soilik. Ikasleen edukia eta identifikatzaileak ezabatzen dira; testu-balioak ezkutatzen dira. Aurrebista honek ez du telemetriarik bidaltzen, ezta baimenik ematen ere.",
  empty: "Hautatu ikasgela bat politika ikusteko.",
  loading: "Telemetriaren aurrebista kargatzen…",
  error: "Telemetriaren aurrebista ez dago erabilgarri. Saiatu berriro.",
  denied: "Sarbidea ukatu da. Hasi saioa berriro edo hautatu baimendutako ikasgela bat.",
  refresh: "Eguneratu aurrebista",
  enabled: "Telemetria gaituta",
  disabled: "Telemetria desgaituta",
  destinations: "Konfiguratutako helmugak",
  sample: "Datuak ezkutatuta dituen lagin sintetikoa",
  noAttributes: "Lagin honek ez du atributurik.",
};
export function previewMessages(locale: DashboardLocale) {
  return { en, es, eu }[locale];
}
