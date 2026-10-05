import type { DashboardLocale } from "../../messages.js";

const messages = {
  es: {
    title: "Esta clase · Acceso con cuentas externas",
    intro:
      "El alumnado que coincida con alguna de estas entradas puede entrar en esta clase con su cuenta del proveedor. La primera vez Marea le crea la cuenta; si quitas la entrada, pierde el acceso en su siguiente inicio de sesión.",
    values: "Entradas nuevas (una por línea)",
    add: "Añadir",
    remove: "Quitar",
    empty: "Todavía no hay entradas.",
    loading: "Cargando el acceso…",
    saved: "Cambios guardados.",
    rejected: "No se han añadido porque no son válidas:",
    tooMany: "Añade como máximo 200 entradas cada vez.",
    error: "No se pudo cargar o guardar el acceso. Vuelve a intentarlo.",
    conflict:
      "No se pudo aplicar el cambio: la clase admite como máximo 500 entradas y debe estar dada de alta en la administración del centro.",
    retry: "Volver a intentar",
  },
  en: {
    title: "This class · Access with external accounts",
    intro:
      "Students who match any of these entries can join this class with their provider account. Marea creates their account the first time; removing the entry ends their access at their next sign-in.",
    values: "New entries (one per line)",
    add: "Add",
    remove: "Remove",
    empty: "There are no entries yet.",
    loading: "Loading access…",
    saved: "Changes saved.",
    rejected: "These were not added because they are not valid:",
    tooMany: "Add at most 200 entries at a time.",
    error: "Access could not be loaded or saved. Try again.",
    conflict:
      "The change could not be applied: a class accepts at most 500 entries and must be registered in center administration.",
    retry: "Try again",
  },
  eu: {
    title: "Ikasgela hau · Kanpoko kontuekin sartzea",
    intro:
      "Sarrera hauetako batekin bat datozen ikasleak hornitzailearen kontuarekin sar daitezke ikasgela honetan. Lehen aldian Mareak kontua sortzen die; sarrera kentzen baduzu, hurrengo saio-hasieran galduko dute sarbidea.",
    values: "Sarrera berriak (bat lerro bakoitzeko)",
    add: "Gehitu",
    remove: "Kendu",
    empty: "Oraindik ez dago sarrerarik.",
    loading: "Sarbidea kargatzen…",
    saved: "Aldaketak gorde dira.",
    rejected: "Hauek ez dira gehitu, ez baitira baliozkoak:",
    tooMany: "Gehitu gehienez 200 sarrera aldi bakoitzean.",
    error: "Ezin izan da sarbidea kargatu edo gorde. Saiatu berriro.",
    conflict:
      "Ezin izan da aldaketa aplikatu: ikasgela batek gehienez 500 sarrera onartzen ditu eta ikastetxearen administrazioan erregistratuta egon behar du.",
    retry: "Saiatu berriro",
  },
} as const;

export function externalAccessMessages(locale: DashboardLocale) {
  return messages[locale];
}
