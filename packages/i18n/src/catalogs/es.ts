import type { CompleteCatalog } from "../keys.js";

const spanishCatalog = {
  "bootstrap.checking-connection": "Comprobando la conexión con el servidor del profesor…",
  "bootstrap.connection-failed":
    "No se ha podido conectar con el servidor del profesor. Comprueba la conexión e inténtalo de nuevo.",
  "bootstrap.login-required": "Inicia sesión para conectar Marea con tu servidor del profesor.",
  "bootstrap.ready": "Marea está lista.",
  "bootstrap.resuming-session": "Reanudando tu sesión…",
  "bootstrap.starting-session": "Iniciando tu sesión…",
  "errors.auth.invalid": "La autenticación ha fallado. Inicia sesión de nuevo.",
  "errors.protocol.incompatible": "Este cliente no es compatible con el servidor del profesor.",
  "errors.request.invalid": "No se ha podido entender la solicitud.",
  "errors.run.unavailable": "La sesión ya no está disponible.",
  "errors.server.error": "El servidor del profesor no ha podido completar la solicitud.",
  "student.auth.class": "¿En qué clase vas a trabajar?",
  "student.auth.display-name-label": "Nombre que verá tu profesor",
  "student.auth.external": "Entrar con {{provider}}",
  "student.auth.external-complete": "Ya puedes cerrar esta ventana y volver a Marea.",
  "student.auth.external-failed":
    "No se ha podido completar el acceso. Cierra esta ventana e inténtalo de nuevo desde Marea.",
  "student.auth.external-open": "Abre esta dirección en tu navegador para continuar: {{url}}",
  "student.auth.enroll": "Crear mi cuenta con una invitación",
  "student.auth.invitation-label": "Código de invitación",
  "student.auth.login": "Iniciar sesión",
  "student.auth.login-label": "Usuario",
  "student.auth.method": "¿Cómo quieres acceder?",
  "student.auth.method-rejected":
    "Tu sesión guardada ya no es válida. ¿Cómo quieres acceder de nuevo?",
  "student.auth.password-label": "Contraseña",
  "student.auth.required": "Este campo es obligatorio.",
  "student.cli.help":
    "Uso: marea [--server <URL>] [--lang <locale>] [--no-mouse]\n     marea feedback\n     marea feedback --ack <id-aviso>\n\nAbre Marea en el proyecto actual, consulta el feedback docente pendiente o marca un aviso como leído. Usa --lang automatic, es, en o eu para esta ejecución.",
  "student.cli.invalid-language":
    "La opción de idioma {{option}} no es válida. Usa automatic, es, en o eu.",
  "student.cli.language-save-failed":
    "No se ha podido guardar el idioma de la interfaz. Solo estará activo durante esta sesión.",
  "student.cli.server-url-missing":
    "Marea todavía no tiene configurada la dirección del servidor del profesor.",
  "student.cli.unexpected-error": "Marea no ha podido iniciarse. Inténtalo de nuevo.",
  "student.feedback.ack-hint": "Cuando lo hayas leído, márcalo como leído con: {{command}}",
  "student.feedback.acknowledged": "Feedback marcado como leído.",
  "student.feedback.empty": "No hay feedback docente pendiente.",
  "student.feedback.failed":
    "No se ha podido confirmar el feedback. Repite el mismo comando; es seguro reintentarlo.",
  "student.feedback.heading": "Feedback docente pendiente (hasta 32 avisos)",
  "student.feedback.login-required":
    "No hay un acceso de alumno guardado para este servidor y proyecto. Inicia sesión con marea primero.",
  "student.git.cancel": "Cancelar",
  "student.git.cancelled": "Crea el repositorio cuando quieras y vuelve a iniciar Marea.",
  "student.git.confirm":
    "Marea necesita un repositorio Git para registrar tus cambios y mostrarlos al profesor. ¿Crearlo en esta carpeta?",
  "student.git.create": "Sí, crear repositorio",
  "student.git.missing":
    "Marea necesita Git para registrar tu trabajo. Instala Git y vuelve a iniciar Marea.",
  "student.git.not-root":
    "Abre Marea desde la raíz del repositorio para registrar únicamente ese proyecto.",
  "student.conversation.approve": "Y aprobar",
  "student.conversation.input-placeholder": "Escribe un mensaje",
  "student.conversation.marea-label": "Marea",
  "student.conversation.reject": "N rechazar",
  "student.conversation.retry": "Escribe /retry para reintentar",
  "student.conversation.status-cancelled": "Turno cancelado",
  "student.conversation.status-failed": "El turno ha fallado",
  "student.conversation.student-label": "Tú",
  "student.conversation.title": "Marea · aula",
  "student.tui.approval.approve": "Autorizar",
  "student.tui.approval.approved": "Autorizado",
  "student.tui.approval.cancelled": "Cancelado",
  "student.tui.approval.collapse": "v contraer",
  "student.tui.approval.edit-after": "+ después",
  "student.tui.approval.edit-before": "- antes",
  "student.tui.approval.edit-all": "todas las apariciones",
  "student.tui.approval.edit-one": "una aparición",
  "student.tui.approval.execute-warning":
    "El comando se ejecutará con tus permisos del sistema; puede modificar archivos fuera del proyecto.",
  "student.tui.approval.expand": "> mostrar todo",
  "student.tui.approval.lines": "{{count}} línea(s)",
  "student.tui.approval.lines.one": "{{count}} línea",
  "student.tui.approval.lines.other": "{{count}} líneas",
  "student.tui.approval.reason-placeholder": "Motivo opcional; Enter para confirmar",
  "student.tui.approval.reject": "Rechazar",
  "student.tui.approval.rejected": "Rechazado",
  "student.tui.approval.rejected-with-reason": "Rechazado: {{reason}}",
  "student.tui.approval.title": "Autorizar · {{name}}",
  "student.tui.banner.branch": "rama",
  "student.tui.banner.directory": "directorio",
  "student.tui.banner.footer": "/help para los comandos · /exit para terminar",
  "student.tui.banner.model": "modelo",
  "student.tui.banner.repository": "repositorio",
  "student.tui.command.details-description": "alternar outputs compactos o detallados",
  "student.tui.command.exit-description": "salir de Marea",
  "student.tui.command.help-description": "mostrar los comandos y atajos",
  "student.tui.command.language-description": "cambiar el idioma de la interfaz",
  "student.tui.command.retry-description": "reanudar el último turno interrumpido",
  "student.tui.composer.placeholder": "Escribe a Marea…",
  "student.tui.failure.recovery-pending": "Hay un turno guardado pendiente de reanudación.",
  "student.tui.failure.deadline-exceeded": "Se ha alcanzado el tiempo máximo de esta petición.",
  "student.tui.failure.budget-exhausted":
    "La sesión no dispone de presupuesto suficiente para otra petición.",
  "student.tui.failure.concurrency-limited": "Hay otra petición en curso. Espera a que termine.",
  "student.tui.failure.provider-interrupted": "El proveedor ha interrumpido la respuesta.",
  "student.tui.failure.resume-detail": "Puedes reanudar el turno desde el último punto guardado.",
  "student.tui.help": `## Comandos

- \`/help\` — muestra esta ayuda.
- \`/retry\` — reanuda el último turno interrumpido sin repetir tu mensaje.
- \`/details\` — alterna entre outputs compactos y completos.
- \`/language\` — cambia el idioma de la interfaz y guarda la preferencia.
- \`/exit\` — termina la sesión.

## Teclado

- **Enter** envía el mensaje; **Shift+Enter** o **Ctrl+J** añaden una línea.
- Mientras Marea responde puedes preparar el siguiente mensaje; no se enviará hasta que termine.
- **Tab** y **Shift+Tab** recorren acciones; **Enter** o **Espacio** las activan.
- **PageUp** y **PageDown** recorren la conversación.
- **Ctrl+O** despliega o contrae el último output.
- Con el prompt vacío, **Ctrl+E** despliega o contrae todos los outputs del turno.
- **Escape** interrumpe el turno actual.
- La rueda o el trackpad recorren la conversación.
- Selecciona texto con el ratón para copiarlo automáticamente al soltar.
- Inicia Marea con \`--no-mouse\` si necesitas la selección nativa del terminal.
- **Ctrl+D** cierra Marea.
- En una autorización, **y** autoriza y **n** permite rechazar con un motivo.
`,
  "student.tui.hint.approval": "Y autorizar · N rechazar · Shift+Tab revisar",
  "student.tui.hint.questions": "Tab navegar · Enter continuar",
  "student.tui.hint.ready": "Ctrl+O último output · PgUp/PgDn conversación · /help",
  "student.tui.hint.turn": "Esc interrumpir",
  "student.tui.notice.clipboard": "Texto copiado al portapapeles",
  "student.tui.notice.quit-hint": "Pulsa Ctrl+D para salir.",
  "student.tui.notice.draft-kept": "Podrás enviarlo cuando Marea termine de responder.",
  "student.tui.notice.no-outputs": "Todavía no hay outputs",
  "student.tui.notice.no-retry": "No hay ningún turno interrumpido para reintentar",
  "student.tui.notice.no-turn-outputs": "Este turno todavía no tiene outputs",
  "student.tui.notice.language-changed": "Idioma de la interfaz: {{language}}",
  "student.tui.notice.language-save-failed":
    "El nuevo idioma de la interfaz está activo, pero no se ha podido guardar.",
  "student.tui.notice.outputs-compact": "Outputs compactos",
  "student.tui.notice.outputs-detailed": "Outputs detallados",
  "student.tui.notice.retrying": "↻ Reintentando el turno interrumpido…",
  "student.tui.question.cancelled": "Cancelado",
  "student.tui.question.next": "Siguiente",
  "student.tui.question.placeholder": "Número de opción o respuesta",
  "student.tui.question.previous": "Anterior",
  "student.tui.question.progress": "Pregunta {{index}} de {{total}}",
  "student.tui.question.required": "Esta pregunta es obligatoria.",
  "student.tui.question.send": "Enviar respuestas",
  "student.tui.question.sent": "Respuestas enviadas",
  "student.tui.question.title": "El agente necesita que decidas",
  "student.tui.status.detail": "{{seconds}}s",
  "student.tui.status.finishing": "finalizando",
  "student.tui.status.preparing": "Preparando la sesión…",
  "student.tui.status.ready": "listo",
  "student.tui.status.responding": "respondiendo",
  "student.tui.status.retrying": "reintentando",
  "student.tui.status.reviewing": "revisando proyecto",
  "student.tui.status.starting": "preparando",
  "student.tui.status.thinking": "pensando",
  "student.tui.status.unrecoverable": "error no recuperable",
  "student.tui.status.waiting-answer": "esperando respuesta",
  "student.tui.status.waiting-approval": "esperando autorización",
  "student.tui.tool.empty-output": "(sin output)",
  "student.tui.tool.lines-read": "{{count}} líneas leídas",
  "student.tui.tool.lines-read.one": "{{count}} línea leída",
  "student.tui.tool.lines-read.other": "{{count}} líneas leídas",
  "student.tui.tool.omitted-many": "… {{count}} líneas anteriores",
  "student.tui.tool.omitted-many.one": "… {{count}} línea anterior",
  "student.tui.tool.omitted-many.other": "… {{count}} líneas anteriores",
  "student.tui.tool.omitted-one": "… 1 línea anterior",
  "student.tui.tool.output": "output",
  "student.tui.tool.question": "pregunta",
  "student.tui.tool.see-content": "Ctrl+O para ver el contenido",
  "student.tui.tool.see-output": "Ctrl+O para ver el output completo",
  "student.tui.tool.subagent": "subagente",
  "student.tui.turn.driver-failed": "La interfaz no pudo completar el turno.",
  "student.tui.turn.interrupted": "Turno interrumpido.",
  "student.tui.turn.retry": "Reintentar / continuar",
  "student.tui.turn.retry-started": "Reintento iniciado",
  "skills.allowed-tools.forbidden":
    "Quita `allowed-tools`; los metadatos de una skill educativa no pueden conceder permisos de herramientas.",
  "skills.criteria.duplicate": "Da a cada criterio un `codigo` único dentro de la skill.",
  "skills.criteria.forbidden":
    "Quita `criterios`; las skills de evaluación definen el método de evaluación, no los criterios de aprendizaje.",
  "skills.frontmatter.invalid": "El frontmatter de {{location}} no es válido. {{action}}",
  "skills.frontmatter.missing":
    "Añade frontmatter YAML delimitado por `---` al principio de SKILL.md.",
  "skills.module.forbidden":
    "Quita `module`; las skills educativas de Marea no pueden ejecutar código.",
  "skills.name.invalid":
    "Usa un nombre portable de 1 a 64 caracteres con solo letras ASCII minúsculas, números y guiones simples.",
  "skills.name.mismatch":
    "Cambia el nombre de la carpeta a '{{name}}' o establece name como '{{directory}}'.",
} as const satisfies CompleteCatalog;

export const SPANISH_CATALOG = Object.freeze(spanishCatalog);
