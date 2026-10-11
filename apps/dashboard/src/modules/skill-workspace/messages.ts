import type { DashboardLocale } from "../../messages.js";

const labels = {
  classroom: ["Esta clase", "This class", "Ikasgela hau"],
  students: ["Por alumno", "By student", "Ikasleka"],
  library: ["Biblioteca", "Library", "Liburutegia"],
  add: ["Añadir skills", "Add skills", "Gehitu skillak"],
  select: ["Guardar selección", "Save selection", "Gorde hautaketa"],
  search: ["Buscar skills", "Search skills", "Bilatu skillak"],
  studentSearch: ["Buscar alumno", "Search students", "Bilatu ikaslea"],
  newSkill: ["Nueva skill", "New skill", "Skill berria"],
  practice: ["Para practicar", "For practice", "Praktikatzeko"],
  evaluation: ["Para evaluar", "For assessment", "Ebaluatzeko"],
  evaluationHelp: [
    "El método de evaluación configura al evaluador. No se envía al tutor del alumno.",
    "The assessment method configures the evaluator. It is never sent to the student's tutor.",
    "Ebaluazio-metodoak ebaluatzailea konfiguratzen du. Ez zaio ikaslearen tutoreari bidaltzen.",
  ],
  all: ["Todas", "All", "Denak"],
  mine: ["Mis skills", "My skills", "Nire skillak"],
  included: ["Incluidas en Marea", "Included with Marea", "Marearekin datozenak"],
  center: ["Del centro", "School library", "Ikastetxekoak"],
  empty: [
    "Todavía no hay skills en esta selección.",
    "There are no skills in this selection yet.",
    "Oraindik ez dago skillik hautaketa honetan.",
  ],
  missing: ["No disponible en la biblioteca", "Unavailable in the library", "Ez dago liburutegian"],
  noEvaluation: ["Sin método de evaluación", "No assessment method", "Ebaluazio-metodorik gabe"],
  noResults: [
    "No hay resultados para esta búsqueda.",
    "No results for this search.",
    "Ez dago emaitzarik bilaketa honetarako.",
  ],
  inherited: ["De la clase", "From the class", "Ikasgelakoak"],
  custom: ["Personalizada", "Personal selection", "Pertsonalizatua"],
  inheritAction: [
    "Usar las de la clase",
    "Use the class selection",
    "Erabili ikasgelako hautaketa",
  ],
  customize: ["Elegir para este alumno", "Choose for this student", "Aukeratu ikasle honentzat"],
  customizeMany: [
    "Elegir para los seleccionados",
    "Choose for selected students",
    "Aukeratu hautatutakoentzat",
  ],
  customHelp: [
    "Esta selección sustituye a la de la clase y se conserva entre sesiones. Los cambios en la selección de la clase no la modifican.",
    "This selection replaces the class selection and persists across sessions. Changes to the class selection do not change it.",
    "Hautaketa honek ikasgelakoa ordezkatzen du eta saioen artean mantentzen da. Ikasgelako hautaketaren aldaketek ez dute hau aldatzen.",
  ],
  noStudents: [
    "El alumnado aparecerá aquí cuando se incorpore a la clase.",
    "Students appear here when they join the class.",
    "Ikasleak hemen agertuko dira ikasgelan sartzen direnean.",
  ],
  name: ["Nombre", "Name", "Izena"],
  description: ["Descripción breve", "Short description", "Deskribapen laburra"],
  instructions: ["Instrucciones para el tutor", "Tutor instructions", "Tutorearentzako argibideak"],
  evaluatorInstructions: [
    "Instrucciones para el evaluador",
    "Evaluator instructions",
    "Ebaluatzailearentzako argibideak",
  ],
  criteria: ["Criterios de evaluación", "Assessment criteria", "Ebaluazio-irizpideak"],
  addCriterion: ["Añadir criterio", "Add criterion", "Gehitu irizpidea"],
  code: ["Código", "Code", "Kodea"],
  statement: [
    "Qué debe demostrar",
    "What the student should demonstrate",
    "Ikasleak erakutsi behar duena",
  ],
  resources: ["Materiales adicionales", "Additional materials", "Material osagarriak"],
  advanced: ["Editar archivos", "Edit files", "Editatu fitxategiak"],
  basics: ["Volver al formulario", "Back to the form", "Itzuli formulariora"],
  importFiles: ["Importar archivos", "Import files", "Inportatu fitxategiak"],
  exportFile: ["Descargar archivo", "Download file", "Deskargatu fitxategia"],
  preview: ["Vista previa", "Preview", "Aurrebista"],
  edit: ["Editar", "Edit", "Editatu"],
  copy: ["Crear mi versión", "Create my version", "Sortu nire bertsioa"],
  remove: ["Quitar", "Remove", "Kendu"],
  cancel: ["Cancelar", "Cancel", "Utzi"],
  close: ["Cerrar", "Close", "Itxi"],
  back: ["Volver", "Back", "Itzuli"],
  save: ["Guardar y aplicar", "Save and apply", "Gorde eta aplikatu"],
  saveNew: ["Guardar en biblioteca", "Save to library", "Gorde liburutegian"],
  saved: ["Cambios guardados.", "Changes saved.", "Aldaketak gordeta."],
  assigned: [
    "Selección guardada para las sesiones nuevas.",
    "Selection saved for new sessions.",
    "Hautaketa saio berrietarako gordeta.",
  ],
  draft: [
    "Borrador conservado en esta pestaña",
    "Draft kept in this tab",
    "Zirriborroa fitxa honetan gordeta",
  ],
  discard: ["Descartar borrador", "Discard draft", "Baztertu zirriborroa"],
  required: ["Completa este campo.", "Complete this field.", "Bete eremu hau."],
  invalid: [
    "Revisa los campos marcados y los archivos de la skill.",
    "Check the marked fields and the skill files.",
    "Berrikusi markatutako eremuak eta skillaren fitxategiak.",
  ],
  unavailable: [
    "No se ha podido completar la operación. Tu borrador se conserva; vuelve a cargar los datos antes de reintentar.",
    "The operation could not be completed. Your draft is preserved; reload the data before retrying.",
    "Ezin izan da eragiketa osatu. Zirriborroa mantendu da; kargatu berriro datuak saiatu aurretik.",
  ],
  copyDraft: ["Guardar como otra skill", "Save as another skill", "Gorde beste skill gisa"],
  conflict: [
    "Alguien ha cambiado estos datos. Vuelve a cargarlos y revisa tu selección. Si estabas editando una skill, puedes guardar el borrador como otra skill o descartarlo para abrir la versión actual.",
    "These data have changed. Reload them and review your selection. If editing a skill, save the draft as another skill or discard it to open the current version.",
    "Datuak aldatu dira. Kargatu berriro eta berrikusi hautaketa. Skill bat editatzen ari bazinen, gorde zirriborroa beste skill gisa edo baztertu uneko bertsioa irekitzeko.",
  ],
  applyProblem: [
    "La skill está guardada en la biblioteca, pero no se han actualizado las asignaciones. Revisa los destinos y aplica los cambios.",
    "The skill is saved in the library, but assignments were not updated. Review the destinations and apply the changes.",
    "Skilla liburutegian gordeta dago, baina esleipenak ez dira eguneratu. Berrikusi helburuak eta aplikatu aldaketak.",
  ],
  review: ["Revisar destinos", "Review destinations", "Berrikusi helburuak"],
  apply: ["Aplicar cambios", "Apply changes", "Aplikatu aldaketak"],
  loading: ["Cargando skills…", "Loading skills…", "Skillak kargatzen…"],
  working: ["Guardando…", "Saving…", "Gordetzen…"],
  reload: ["Volver a cargar", "Reload", "Kargatu berriro"],
  uses: ["Dónde se utiliza", "Where it is used", "Non erabiltzen den"],
  unused: ["Todavía no está asignada.", "Not assigned yet.", "Oraindik esleitu gabe."],
  future: [
    "Los cambios se aplican a las sesiones nuevas. Las conversaciones en curso conservan su contenido.",
    "Changes apply to new sessions. Conversations in progress keep their content.",
    "Aldaketak saio berrietan aplikatzen dira. Abian diren elkarrizketek edukia mantentzen dute.",
  ],
  noClass: [
    "Selecciona una clase para gestionar sus skills.",
    "Select a class to manage its skills.",
    "Hautatu ikasgela bat haren skillak kudeatzeko.",
  ],
  noConfiguration: [
    "Guarda primero la configuración del tutor en Ajustes → Esta clase.",
    "First save the tutor configuration in Settings → This class.",
    "Lehenik gorde tutorearen konfigurazioa Ezarpenak → Ikasgela hau atalean.",
  ],
  free: [
    "Esta clase usa el modo libre. Las skills didácticas se conservan y se usarán al activar el modo tutor.",
    "This class uses free mode. Didactic skills are retained and will be used when tutoring mode is enabled.",
    "Ikasgela honek modu librea erabiltzen du. Skill didaktikoak mantentzen dira eta tutore modua aktibatzean erabiliko dira.",
  ],
  emptyChoice: ["Sin skills didácticas", "No didactic skills", "Skill didaktikorik gabe"],
} as const;

export function skillWorkspaceMessages(locale: DashboardLocale) {
  const index = locale === "es" ? 0 : locale === "eu" ? 2 : 1;
  const text = Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key, value[index]]),
  ) as Record<keyof typeof labels, string>;
  return {
    ...text,
    impact: (classes: number, students: number) =>
      locale === "es"
        ? `Se actualizará en ${String(classes)} clases y ${String(students)} selecciones individuales.`
        : locale === "eu"
          ? `${String(classes)} ikasgelatan eta ${String(students)} banakako hautaketatan eguneratuko da.`
          : `Will update ${String(classes)} classes and ${String(students)} individual selections.`,
  };
}
export type SkillWorkspaceMessages = ReturnType<typeof skillWorkspaceMessages>;
