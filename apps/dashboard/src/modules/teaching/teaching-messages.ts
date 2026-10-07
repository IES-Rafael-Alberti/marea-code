import type { Locale } from "@marea/i18n";

/** All teacher-facing copy for the teaching configuration module, per locale. */
export function teachingMessages(locale: Locale) {
  return locale === "en"
    ? {
        heading: "Class teaching configuration",
        busy: "Working…",
        classesHeading: "Classes",
        classesLoading: "Loading classes…",
        classesEmpty: "No classes are assigned to you yet.",
        classesError: "Classes could not be loaded.",
        classSelector: "Class",
        reloadClasses: "Reload classes",
        chooseClass: "Choose a class to read or create its teaching configuration.",
        firstConfiguration: "First configuration: nothing is saved for this class yet.",
        savedVersion: (version: string) => `Saved version ${version}`,
        modeLabel: "Agent mode",
        modes: { tutoring: "Guided tutoring", free: "Free mode" },
        socraticLabel: "Socratic writing gate",
        socraticModes: {
          off: "Off",
          normal: "Block the first attempt",
          strict: "Block up to three attempts",
        },
        socraticHelp:
          "In each student turn, pauses exercise code writes or edits until the tutor asks a question, or reaches the attempt limit. Free mode, setup files and shell commands are excluded. Student approval is still required. New sessions only; older clients must update.",
        instructionsNote:
          "Edit the complete instructions for each mode; neither field can be empty. Restoring defaults only changes this draft; save to apply it to new sessions. Tool permissions and safety rules remain enforced separately.",
        restoreTutoring: "Restore guided mode defaults",
        restoreFree: "Restore free mode defaults",
        tutoringInstructions: "Guided mode instructions",
        freeInstructions: "Free mode instructions",
        freeModeNote:
          "Free mode excludes didactic startup and materialization but keeps normal tool permissions.",
        saveNote:
          "Saves affect new sessions only; already-open snapshots keep their frozen configuration.",
        didacticLegend: "Didactic skills",
        evaluationLegend: "Evaluation methods",
        didacticCap: "Up to 64 didactic skills can be selected.",
        automaticEvaluation: "Automatic evaluation",
        automaticEvaluationNote:
          "Automatic evaluation stays off without a selected evaluation method.",
        skillCurrent: "Current version",
        skillStale: "Stale selection: the saved digest differs from this version.",
        skillMissing: "Missing selection: this version is not in the current catalog.",
        digest: "Digest",
        source: "Source",
        description: "Description",
        reselect: "Reselect this version",
        remove: "Remove",
        problems: {
          load: "Classes could not be loaded.",
          invalid: "The server rejected the request as invalid.",
          forbidden: "You do not have access to this class.",
          conflict: "The saved configuration changed while you were editing.",
          uncertain: "The save outcome is unknown. Your draft is preserved.",
          unconfigured:
            "No model is configured for this class. Save a provider and model in Settings → Server, then reload this class.",
          "skill-unavailable": "A selected skill is unavailable or stale on the server.",
        },
        operatorWarning:
          "Save a provider and model in Settings → Server, then reload this class to save its teaching settings. Ask the server administrator if you cannot manage connections.",
        save: "Save configuration",
        saveBlocked: "Save configuration (blocked)",
        reloadCurrent: "Reload current configuration",
        recoveryHeading: "Recovery: current saved configuration",
        recoveryNote:
          "Your draft is preserved next to the current saved values. Nothing is overwritten automatically.",
        currentValues: "Persisted values (read-only)",
        noCurrent: "No configuration is saved for this class yet.",
        discardDraft: "Discard draft and keep current",
        acceptCurrent: "Accept current configuration",
        switchPrompt: (name: string) => `Switch to ${name}? Unsaved draft changes will be lost.`,
        switchDiscard: "Discard draft and switch",
        switchCancel: "Cancel",
        noDraft: "Reading the configuration…",
      }
    : locale === "eu"
      ? {
          heading: "Ikasgelako irakaskuntza-konfigurazioa",
          busy: "Lanean…",
          classesHeading: "Ikasgelak",
          classesLoading: "Ikasgelak kargatzen…",
          classesEmpty: "Oraindik ez zaizu ikasgelarik esleitu.",
          classesError: "Ezin izan dira ikasgelak kargatu.",
          classSelector: "Ikasgela",
          reloadClasses: "Birkargatu ikasgelak",
          chooseClass:
            "Aukeratu ikasgela haren irakaskuntza-konfigurazioa irakurtzeko edo sortzeko.",
          firstConfiguration:
            "Lehen konfigurazioa: oraindik ez dago ezer gordeta ikasgela honetarako.",
          savedVersion: (version: string) => `Gordetako bertsioa ${version}`,
          modeLabel: "Agente-modua",
          modes: { tutoring: "Tutoretza gidatua", free: "Modu librea" },
          socraticLabel: "Idazketaren blokeo sokratikoa",
          socraticModes: {
            off: "Desaktibatuta",
            normal: "Blokeatu lehen saiakera",
            strict: "Blokeatu hiru saiakera gehienez",
          },
          socraticHelp:
            "Ikaslearen txanda bakoitzean, ariketako kodearen idazketa eta edizioa eteten ditu tutoreak galdera bat egin arte edo saiakera-mugara heldu arte. Modu librea, konfigurazio-fitxategiak eta shell-komandoak kanpoan geratzen dira. Ikaslearen baimena behar da beti. Saio berrietan soilik; bezero zaharrak eguneratu behar dira.",
          instructionsNote:
            "Editatu modu bakoitzeko argibide osoak; ezin da eremurik hutsik utzi. Lehenetsiak leheneratzeak zirriborro hau baino ez du aldatzen; gorde saio berrietan aplikatzeko. Tresnen baimenak eta segurtasun-arauak bereiz mantentzen dira.",
          restoreTutoring: "Leheneratu modu gidatuaren lehenetsiak",
          restoreFree: "Leheneratu modu librearen lehenetsiak",
          tutoringInstructions: "Modu gidatuaren argibideak",
          freeInstructions: "Modu librearen argibideak",
          freeModeNote:
            "Modu libreak abiarazte eta materializazio didaktikoak baztertzen ditu, baina tresnen baimen arruntak mantentzen ditu.",
          saveNote:
            "Gordetzeek saio berriei baino ez diete eragiten; dagoeneko irekita dauden saioek konfigurazio izoztua mantentzen dute.",
          didacticLegend: "Skill didaktikoak",
          evaluationLegend: "Ebaluazio-metodoak",
          didacticCap: "Gehienez 64 skill didaktiko hauta daitezke.",
          automaticEvaluation: "Ebaluazio automatikoa",
          automaticEvaluationNote:
            "Ebaluazio automatikoa itzalita egoten da ebaluazio-metodorik hautatu gabe.",
          skillCurrent: "Uneko bertsioa",
          skillStale: "Hautaketa zaharkituta: gordetako digest-a bertsio honetatik desberdina da.",
          skillMissing: "Hautaketa falta da: bertsio hau ez dago uneko katalogoan.",
          digest: "Digest-a",
          source: "Iturria",
          description: "Deskribapena",
          reselect: "Hautatu berriro bertsio hau",
          remove: "Kendu",
          problems: {
            load: "Ezin izan dira ikasgelak kargatu.",
            invalid: "Zerbitzariak eskaera baliogabetzat baztertu du.",
            forbidden: "Ez duzu ikasgela honetarako sarbiderik.",
            conflict: "Gordetako konfigurazioa aldatu egin da editatzen ari zinela.",
            uncertain: "Ez dago gordetzearen emaitza berretsita. Zure zirriborroa mantendu da.",
            unconfigured:
              "Ikasgela honek ez du eredurik konfiguratuta. Gorde hornitzailea eta eredua Ezarpenak → Zerbitzaria atalean eta kargatu ikasgela berriro.",
            "skill-unavailable":
              "Hautatutako skill-a ez dago eskuragarri edo zaharkituta dago zerbitzarian.",
          },
          operatorWarning:
            "Gorde hornitzailea eta eredua Ezarpenak → Zerbitzaria atalean eta kargatu ikasgela berriro irakaskuntza-ezarpenak gordetzeko. Konexioak kudeatu ezin badituzu, eskatu zerbitzariaren administratzaileari.",
          save: "Gorde konfigurazioa",
          saveBlocked: "Gorde konfigurazioa (blokeatuta)",
          reloadCurrent: "Birkargatu uneko konfigurazioa",
          recoveryHeading: "Berreskuratzea: gordetako uneko konfigurazioa",
          recoveryNote:
            "Zure zirriborroa gordetako balioen ondoan mantentzen da. Ez da ezer automatikoki gainidazten.",
          currentValues: "Gordetako balioak (irakurtzeko soilik)",
          noCurrent: "Oraindik ez dago konfiguraziorik gordeta ikasgela honetarako.",
          discardDraft: "Baztertu zirriborroa eta mantendu unekoa",
          acceptCurrent: "Onartu uneko konfigurazioa",
          switchPrompt: (name: string) =>
            `Beste ikasgela hau hautatu nahi duzu: ${name}? Gorde gabeko zirriborro-aldaketak galduko dira.`,
          switchDiscard: "Baztertu zirriborroa eta aldatu",
          switchCancel: "Utzi",
          noDraft: "Konfigurazioa irakurtzen…",
        }
      : {
          heading: "Configuración docente de la clase",
          busy: "Procesando…",
          classesHeading: "Clases",
          classesLoading: "Cargando clases…",
          classesEmpty: "Todavía no tienes clases asignadas.",
          classesError: "No se han podido cargar las clases.",
          classSelector: "Clase",
          reloadClasses: "Recargar clases",
          chooseClass: "Elige una clase para leer o crear su configuración docente.",
          firstConfiguration:
            "Primera configuración: todavía no hay nada guardado para esta clase.",
          savedVersion: (version: string) => `Versión guardada ${version}`,
          modeLabel: "Modo del agente",
          modes: { tutoring: "Tutoría guiada", free: "Modo libre" },
          socraticLabel: "Bloqueo de escritura del tutor",
          socraticModes: {
            off: "Desactivado",
            normal: "Bloquear el primer intento",
            strict: "Bloquear hasta tres intentos",
          },
          socraticHelp:
            "En cada turno del alumno, frena la escritura o edición de código del ejercicio hasta que el tutor haga una pregunta o alcance el límite de intentos. No afecta al modo libre, los archivos de configuración ni los comandos de terminal. El alumno sigue teniendo que autorizar los cambios. Solo se aplica a sesiones nuevas; los clientes antiguos deberán actualizarse.",
          instructionsNote:
            "Edita las instrucciones completas de cada modo; ninguno de los dos campos puede quedar vacío. Restaurar los valores predeterminados solo cambia este borrador; guarda para aplicarlo a sesiones nuevas. Los permisos de herramientas y las reglas de seguridad se mantienen por separado.",
          restoreTutoring: "Restaurar instrucciones del modo guiado",
          restoreFree: "Restaurar instrucciones del modo libre",
          tutoringInstructions: "Instrucciones del modo guiado",
          freeInstructions: "Instrucciones del modo libre",
          freeModeNote:
            "El modo libre omite el arranque y la materialización didácticos, pero conserva los permisos normales de herramientas.",
          saveNote:
            "Los guardados afectan solo a las sesiones nuevas; las sesiones ya abiertas conservan su configuración congelada.",
          didacticLegend: "Skills didácticas",
          evaluationLegend: "Métodos de evaluación",
          didacticCap: "Se pueden seleccionar hasta 64 skills didácticas.",
          automaticEvaluation: "Evaluación automática",
          automaticEvaluationNote:
            "La evaluación automática permanece desactivada sin un método de evaluación seleccionado.",
          skillCurrent: "Versión actual",
          skillStale: "Selección desactualizada: el digest guardado difiere de esta versión.",
          skillMissing: "Selección ausente: esta versión no está en el catálogo actual.",
          digest: "Digest",
          source: "Fuente",
          description: "Descripción",
          reselect: "Reseleccionar esta versión",
          remove: "Quitar",
          problems: {
            load: "No se han podido cargar las clases.",
            invalid: "El servidor ha rechazado la solicitud por no ser válida.",
            forbidden: "No tienes acceso a esta clase.",
            conflict: "La configuración guardada ha cambiado mientras editabas.",
            uncertain: "El resultado del guardado es desconocido. Tu borrador se conserva.",
            unconfigured:
              "Esta clase no tiene un modelo configurado. Guarda un proveedor y modelo en Ajustes → Servidor y recarga la clase.",
            "skill-unavailable": "Una skill seleccionada no está disponible o está desactualizada.",
          },
          operatorWarning:
            "Guarda un proveedor y modelo en Ajustes → Servidor y recarga esta clase para poder guardar sus ajustes docentes. Si no administras las conexiones, pídeselo al administrador del servidor.",
          save: "Guardar configuración",
          saveBlocked: "Guardar configuración (bloqueado)",
          reloadCurrent: "Recargar configuración actual",
          recoveryHeading: "Recuperación: configuración guardada actual",
          recoveryNote:
            "Tu borrador se conserva junto a los valores guardados actuales. Nada se sobrescribe automáticamente.",
          currentValues: "Valores persistidos (solo lectura)",
          noCurrent: "Todavía no hay configuración guardada para esta clase.",
          discardDraft: "Descartar borrador y quedarse con la actual",
          acceptCurrent: "Aceptar la configuración actual",
          switchPrompt: (name: string) =>
            `¿Cambiar a ${name}? Los cambios sin guardar se perderán.`,
          switchDiscard: "Descartar el borrador y cambiar",
          switchCancel: "Cancelar",
          noDraft: "Leyendo la configuración…",
        };
}

export type TeachingMessages = ReturnType<typeof teachingMessages>;
