import type { DashboardLocale } from "../../messages.js";

/** Specific, localized explanations of a failed report and of each unavailable session. */
const en = {
  failures: {
    "analysis-failed":
      "The analysis failed for an unexpected reason. Try again; if it keeps failing, contact the administrator.",
    "output-invalid":
      "The model did not return a usable analysis, even after a second attempt. Try again or choose a shorter period.",
    "input-too-large":
      "The material is too large for the configured model. Choose a shorter period or ask the administrator to raise the model's input limit.",
    budget: "The analysis budget is exhausted. Ask the administrator to raise it.",
    provider:
      "The model provider is not responding or rejected the request. Check the connection and try again.",
    deadline: "The model took too long to answer. Try again or choose a shorter period.",
    unconfigured: "No model is configured for reports. Configure the connection and try again.",
    "access-revoked": "Your access to this class ended while the report was being generated.",
    interrupted: "The server restarted while the report was being generated. Start a new attempt.",
    "evidence-deleted": "The evidence of this report was deleted.",
  },
  reasons: {
    "no-material": "No conversation to analyze in this session",
    "material-too-large": "Session too large to analyze",
    "no-criteria": "The class has no evaluation criteria",
    "output-invalid": "The model's answer was not usable",
    "input-too-large": "Too large for the configured model",
    budget: "Analysis budget exhausted",
    provider: "Model unavailable",
    deadline: "The model took too long",
    unconfigured: "No model configured",
  },
};
type FailureMessages = typeof en;
const es: FailureMessages = {
  failures: {
    "analysis-failed":
      "El análisis ha fallado por un motivo inesperado. Inténtalo de nuevo; si persiste, avisa al administrador.",
    "output-invalid":
      "El modelo no devolvió un análisis utilizable, ni siquiera tras un segundo intento. Inténtalo de nuevo o elige un periodo más corto.",
    "input-too-large":
      "El material es demasiado grande para el modelo configurado. Elige un periodo más corto o pide al administrador que amplíe el límite de entrada del modelo.",
    budget: "Se ha agotado el presupuesto de análisis. Pide al administrador que lo amplíe.",
    provider:
      "El proveedor del modelo no responde o ha rechazado la petición. Revisa la conexión e inténtalo de nuevo.",
    deadline:
      "El modelo tardó demasiado en responder. Inténtalo de nuevo o elige un periodo más corto.",
    unconfigured:
      "No hay un modelo configurado para los informes. Configura la conexión e inténtalo de nuevo.",
    "access-revoked": "Tu acceso a esta clase terminó mientras se generaba el informe.",
    interrupted:
      "El servidor se reinició mientras se generaba el informe. Inicia un nuevo intento.",
    "evidence-deleted": "Se eliminaron las evidencias de este informe.",
  },
  reasons: {
    "no-material": "No hay conversación que analizar en esta sesión",
    "material-too-large": "Sesión demasiado grande para analizarla",
    "no-criteria": "La clase no tiene criterios de evaluación",
    "output-invalid": "La respuesta del modelo no fue utilizable",
    "input-too-large": "Demasiado grande para el modelo configurado",
    budget: "Presupuesto de análisis agotado",
    provider: "Modelo no disponible",
    deadline: "El modelo tardó demasiado",
    unconfigured: "Sin modelo configurado",
  },
};
const eu: FailureMessages = {
  failures: {
    "analysis-failed":
      "Analisiak ustekabeko arrazoi batengatik huts egin du. Saiatu berriro; jarraitzen badu, jakinarazi administratzaileari.",
    "output-invalid":
      "Ereduak ez du analisi erabilgarririk itzuli, bigarren saiakeraren ondoren ere ez. Saiatu berriro edo aukeratu denbora-tarte laburragoa.",
    "input-too-large":
      "Materiala handiegia da konfiguratutako eredurako. Aukeratu denbora-tarte laburragoa edo eskatu administratzaileari ereduaren sarrera-muga handitzeko.",
    budget: "Analisiaren aurrekontua agortu da. Eskatu administratzaileari handitzeko.",
    provider:
      "Ereduaren hornitzaileak ez du erantzuten edo eskaera baztertu du. Egiaztatu konexioa eta saiatu berriro.",
    deadline:
      "Ereduak denbora gehiegi behar izan du erantzuteko. Saiatu berriro edo aukeratu denbora-tarte laburragoa.",
    unconfigured:
      "Txostenetarako ez dago eredurik konfiguratuta. Konfiguratu konexioa eta saiatu berriro.",
    "access-revoked": "Gela honetarako zure sarbidea amaitu da txostena sortzen ari zen bitartean.",
    interrupted:
      "Zerbitzaria berrabiarazi da txostena sortzen ari zen bitartean. Hasi beste saiakera bat.",
    "evidence-deleted": "Txosten honen ebidentziak ezabatu dira.",
  },
  reasons: {
    "no-material": "Saio honetan ez dago aztertzeko elkarrizketarik",
    "material-too-large": "Saioa handiegia da aztertzeko",
    "no-criteria": "Gelak ez du ebaluazio-irizpiderik",
    "output-invalid": "Ereduaren erantzuna ez zen erabilgarria",
    "input-too-large": "Handiegia konfiguratutako eredurako",
    budget: "Analisiaren aurrekontua agortu da",
    provider: "Eredua ez dago erabilgarri",
    deadline: "Ereduak denbora gehiegi behar izan zuen",
    unconfigured: "Ez dago eredurik konfiguratuta",
  },
};
export function failureMessages(locale: DashboardLocale): FailureMessages {
  return locale === "es" ? es : locale === "eu" ? eu : en;
}
