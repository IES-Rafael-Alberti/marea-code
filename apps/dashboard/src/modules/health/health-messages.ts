import type { DashboardLocale } from "../../messages.js";
const en = {
  title: "Service health",
  meaning:
    "Available and stale describe the last observation this server holds. Unknown means it was not measured.",
  empty: "Select a class to see service health.",
  loading: "Loading service health…",
  error: "Service health is unavailable. Try again.",
  denied: "Access denied. Sign in again or select an authorized class.",
  storage: "Class data storage",
  usageLedger: "Usage records",
  inference: "Tutoring model",
  telemetryDelivery: "Telemetry delivery",
  available: "Available",
  stale: "Stale",
  unknown: "Unknown",
  observed: "Last observed",
  notObserved: "No observation",
  inferenceNote:
    "This server does not check the model service. A configured provider is not proof that it answers.",
  telemetryNote: "Delivery is not confirmed. Configured telemetry is not proof that data arrived.",
  staleAfter: "Observations older than {minutes} minutes are stale.",
  checked: "Checked",
  refresh: "Refresh health",
};
const es: typeof en = {
  title: "Estado del servicio",
  meaning:
    "Disponible y obsoleto describen la última observación que tiene este servidor. Desconocido significa que no se ha medido.",
  empty: "Selecciona una clase para ver el estado del servicio.",
  loading: "Cargando el estado del servicio…",
  error: "El estado del servicio no está disponible. Inténtalo de nuevo.",
  denied: "Acceso denegado. Inicia sesión de nuevo o selecciona una clase autorizada.",
  storage: "Almacenamiento de datos de la clase",
  usageLedger: "Registros de uso",
  inference: "Modelo de tutoría",
  telemetryDelivery: "Entrega de telemetría",
  available: "Disponible",
  stale: "Obsoleto",
  unknown: "Desconocido",
  observed: "Última observación",
  notObserved: "Sin observación",
  inferenceNote:
    "Este servidor no comprueba el servicio del modelo. Tener un proveedor configurado no prueba que responda.",
  telemetryNote:
    "La entrega no está confirmada. Tener telemetría configurada no prueba que los datos hayan llegado.",
  staleAfter: "Las observaciones con más de {minutes} minutos son obsoletas.",
  checked: "Comprobado",
  refresh: "Actualizar estado",
};
const eu: typeof en = {
  title: "Zerbitzuaren egoera",
  meaning:
    "Erabilgarri eta zaharkitua zerbitzari honek duen azken behaketari buruzkoak dira. Ezezagunak esan nahi du ez dela neurtu.",
  empty: "Hautatu ikasgela bat zerbitzuaren egoera ikusteko.",
  loading: "Zerbitzuaren egoera kargatzen…",
  error: "Zerbitzuaren egoera ez dago erabilgarri. Saiatu berriro.",
  denied: "Sarbidea ukatu da. Hasi saioa berriro edo hautatu baimendutako ikasgela bat.",
  storage: "Ikasgelako datuen biltegiratzea",
  usageLedger: "Erabilera-erregistroak",
  inference: "Tutoretza-eredua",
  telemetryDelivery: "Telemetriaren bidalketa",
  available: "Erabilgarri",
  stale: "Zaharkitua",
  unknown: "Ezezaguna",
  observed: "Azken behaketa",
  notObserved: "Behaketarik ez",
  inferenceNote:
    "Zerbitzari honek ez du ereduaren zerbitzua egiaztatzen. Hornitzaile bat konfiguratuta egoteak ez du frogatzen erantzuten duenik.",
  telemetryNote:
    "Bidalketa ez dago berretsita. Telemetria konfiguratuta egoteak ez du frogatzen datuak iritsi direnik.",
  staleAfter: "{minutes} minutu baino zaharragoak diren behaketak zaharkituak dira.",
  checked: "Egiaztatua",
  refresh: "Eguneratu egoera",
};
export function healthMessages(locale: DashboardLocale) {
  return { en, es, eu }[locale];
}
