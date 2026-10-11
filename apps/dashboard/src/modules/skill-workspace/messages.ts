import type { DashboardLocale } from "../../messages.js";

const labels = {
  guide: ["Cómo escribir una skill", "How to write a skill", "Nola idatzi skill bat"],
  guideHeader: [
    "La cabecera entre --- identifica la skill: name, description y, opcionalmente, metadata.title. Debajo escribes las instrucciones completas en Markdown.",
    "The header between --- identifies the skill: name, description and optional metadata.title. Write the complete Markdown instructions below it.",
    "--- marken arteko goiburuak skilla identifikatzen du: name, description eta aukerako metadata.title. Idatzi jarraian Markdown argibide osoak.",
  ],
  guideDidactic: [
    "Como en Testing: explica qué debe dominar el alumno y en qué orden, cómo plantear ejercicios sobre su proyecto, qué preguntas y ayudas ofrecer, qué no resolver por él y cómo reconocer que lo ha entendido.",
    "Like Testing: explain what the learner should master and in what order, exercises in their project, questions and scaffolding, what not to solve for them, and evidence of understanding.",
    "Testing bezala: azaldu zer menperatu behar duen ikasleak eta zein ordenatan, bere proiektuko ariketak, galderak eta laguntzak, zer ez ebatzi haren ordez eta ulermenaren ebidentziak.",
  ],
  guideEvaluation: [
    "Una skill de evaluación describe el método, las evidencias y el formato del feedback para revisión docente. Los criterios los aportan las skills didácticas; no añadas criterios a este archivo.",
    "An assessment skill describes the method, evidence and feedback format for teacher review. Didactic skills supply the criteria; do not add criterios to this file.",
    "Ebaluazio-skill batek metodoa, ebidentziak eta irakasleak berrikusteko feedback-formatua azaltzen ditu. Skill didaktikoek ematen dituzte irizpideak; ez gehitu criterios fitxategi honetan.",
  ],
  guideCriteria: [
    "En las skills didácticas, criterios es opcional: cada entrada tiene codigo y enunciado; niveles, si se incluye, contiene exactamente cuatro descripciones de progreso. Conserva los códigos curriculares que tengas; para criterios propios usa códigos locales.",
    "In didactic skills, criterios is optional: each entry has codigo and enunciado; optional niveles contains exactly four progress descriptions. Keep supplied curriculum codes; use local codes for your own criteria.",
    "Skill didaktikoetan criterios aukerakoa da: sarrera bakoitzak codigo eta enunciado ditu; aukerako niveles eremuak lau aurrerapen-deskribapen zehatz ditu. Mantendu curriculumeko kodeak; erabili tokiko kodeak irizpide propioentzat.",
  ],
  guideName: [
    "name es un identificador de hasta 64 caracteres: minúsculas, números y guiones. Puedes elegirlo al crear; para renombrar una skill guardada cambia metadata.title.",
    "name is an identifier of up to 64 lowercase letters, digits and hyphens. Choose it when creating; change metadata.title to rename a saved skill.",
    "name gehienez 64 karaktereko identifikatzailea da: letra xeheak, zenbakiak eta marratxoak. Aukeratu sortzean; aldatu metadata.title gordetako skillaren izena aldatzeko.",
  ],
  retainedFiles: [
    "Esta skill ya tiene materiales adicionales. Se conservan al guardar el Markdown.",
    "This skill already has companion materials. Saving the Markdown preserves them.",
    "Skill honek material osagarriak ditu. Markdown gordetzean mantentzen dira.",
  ],
  generationTitle: ["Ayúdame a redactarla", "Help me draft it", "Lagundu idazten"],
  generationNotes: [
    "¿Qué quieres trabajar y con qué criterios?",
    "What should students learn, and what are your criteria?",
    "Zer ikasi behar dute eta zein dira zure irizpideak?",
  ],
  generate: ["Generar borrador", "Generate draft", "Sortu zirriborroa"],
  generating: ["Generando borrador…", "Generating draft…", "Zirriborroa sortzen…"],
  generationHelp: [
    "Usa el modelo configurado para esta clase. El texto generado queda pendiente de tu revisión.",
    "Uses the model configured for this class. Generated text awaits your review.",
    "Ikasgela honetarako konfiguratutako modeloa erabiltzen du. Sortutako testua zuk berrikusi behar duzu.",
  ],
  generatedTitle: ["Propuesta del modelo", "Model proposal", "Modeloaren proposamena"],
  generationReplace: [
    "Al usar esta propuesta se sustituye el Markdown del editor. Después puedes editarlo antes de guardar.",
    "Using this proposal replaces the editor Markdown. You can then edit it before saving.",
    "Proposamena erabiltzeak editoreko Markdown ordezkatzen du. Ondoren editatu dezakezu gorde aurretik.",
  ],
  useGenerated: ["Usar este borrador", "Use this draft", "Erabili zirriborro hau"],
  discardGenerated: ["Descartar propuesta", "Discard proposal", "Baztertu proposamena"],
  generationProblem: [
    "No se ha podido generar una skill válida. Comprueba el modelo y la conexión en Ajustes, o revisa las indicaciones y reintenta. Tu texto se conserva.",
    "A valid skill could not be generated. Check the model and connection in Settings, or revise your notes and retry. Your text is preserved.",
    "Ezin izan da baliozko skill bat sortu. Egiaztatu modeloa eta konexioa Ezarpenetan, edo berrikusi oharrak eta saiatu berriro. Zure testua mantendu da.",
  ],
  invalidYaml: [
    "Revisa la cabecera YAML entre ---: campos admitidos, sangría y comillas. metadata.title debe ser texto. No se admiten module ni allowed-tools.",
    "Check the YAML header between ---: supported fields, indentation and quotes. metadata.title must be text. module and allowed-tools are not supported.",
    "Berrikusi --- arteko YAML goiburua: eremuak, koska eta komatxoak. metadata.title testua izan behar da. module eta allowed-tools ez dira onartzen.",
  ],
  invalidName: [
    "name debe coincidir con el identificador de esta skill. Para cambiar el nombre visible, edita metadata.title.",
    "name must match this skill identifier. Edit metadata.title to change the visible name.",
    "name skillaren identifikatzailearekin bat etorri behar da. Aldatu metadata.title ikusgai den izena aldatzeko.",
  ],
  invalidDescription: [
    "Completa description en la cabecera, con un máximo de 1024 caracteres.",
    "Complete description in the header, up to 1024 characters.",
    "Bete description goiburuan, gehienez 1024 karaktererekin.",
  ],
  invalidCriteria: [
    "Revisa criterios: códigos únicos, textos de hasta 1024 caracteres y exactamente cuatro niveles si los incluyes. Las skills de evaluación no llevan criterios.",
    "Check criterios: unique codes, texts up to 1024 characters, and exactly four niveles when supplied. Assessment skills do not contain criterios.",
    "Berrikusi criterios: kode bakarrak, gehienez 1024 karaktereko testuak eta lau niveles zehatz ematen badituzu. Ebaluazio-skillek ez dute criterios eremurik.",
  ],
  invalidBody: [
    "Escribe las instrucciones en Markdown debajo de la cabecera.",
    "Write Markdown instructions below the header.",
    "Idatzi Markdown argibideak goiburuaren azpian.",
  ],
  invalidSize: [
    "El contenido supera el tamaño permitido o contiene caracteres no válidos.",
    "The content exceeds the size limit or contains invalid characters.",
    "Edukiak tamaina-muga gainditzen du edo karaktere baliogabeak ditu.",
  ],
  deleteTitle: ["Eliminar skill", "Delete skill", "Ezabatu skilla"],
  deleteHelp: [
    "Se eliminará de tu biblioteca y de las asignaciones indicadas arriba. Si es el método de evaluación de una clase, se desactivará su evaluación automática.",
    "It will be deleted from your library and the assignments listed above. If it is a class assessment method, automatic assessment will be disabled.",
    "Zure liburutegitik eta goian adierazitako esleipenetatik ezabatuko da. Ikasgela baten ebaluazio-metodoa bada, ebaluazio automatikoa desaktibatuko da.",
  ],
  confirmDelete: [
    "Eliminar y retirar de las asignaciones",
    "Delete and remove from assignments",
    "Ezabatu eta kendu esleipenetatik",
  ],
  deleted: [
    "Skill eliminada y retirada de las asignaciones.",
    "Skill deleted and removed from assignments.",
    "Skilla ezabatu eta esleipenetatik kendu da.",
  ],

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
    locale,
    impact: (classes: number, students: number) =>
      locale === "es"
        ? `Se actualizará en ${String(classes)} clases y ${String(students)} selecciones individuales.`
        : locale === "eu"
          ? `${String(classes)} ikasgelatan eta ${String(students)} banakako hautaketatan eguneratuko da.`
          : `Will update ${String(classes)} classes and ${String(students)} individual selections.`,
  };
}
export type SkillWorkspaceMessages = ReturnType<typeof skillWorkspaceMessages>;
