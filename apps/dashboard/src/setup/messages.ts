import type { DashboardLocale } from "../messages.js";

const es = {
  clearOptional: "Quitar esta configuración opcional",
  school: "Centro y clase",
  account: "Tu cuenta de profesor",
  connectionOptions: "Opciones de conexión",
  change: "Cambiar",
  skip: "Omitir por ahora",
  map: "Mapa de atención",
  mapHelp: "Ayuda a detectar quién puede necesitar tu atención durante la clase.",
  reports: "Informes de clase",
  reportsHelp: "Resume evidencias y dificultades de las sesiones para preparar tu revisión.",
  evaluation: "Evaluación automática",
  evaluationHelp: "Al cerrar una sesión, prepara un borrador que tú revisas antes de compartirlo.",
  testingHelp:
    "Incluye un ejemplo con objetivos y criterios para aprender a probar código. Podrás verlo y adaptarlo después.",
  usageHelp:
    "El mapa, los informes y la evaluación realizan consultas adicionales al modelo elegido. Puedes cambiar su modelo y fijar límites en Ajustes → Servidor.",
  none: "Ninguna por ahora",
  address: "Dirección para el alumnado",
  noAddress:
    "No se ha detectado una dirección de red. Conecta este equipo a la red del aula antes de compartir el instalador.",

  title: "Prepara tu primera clase",
  intro: "Deja tu primera clase lista para trabajar. Podrás cambiar estos ajustes después.",
  steps: [
    "Tu clase",
    "Conecta un modelo",
    "Da acceso al alumnado",
    "Funciones opcionales",
    "Revisa y empieza",
  ] as const,
  center: "Nombre del centro",
  classroom: "Nombre de tu primera clase",
  teacher: "Tu nombre",
  login: "Usuario para entrar al panel",
  password: "Contraseña",
  confirmation: "Repite la contraseña",
  passwordHelp: "Entre 12 y 256 caracteres.",
  mismatch: "Las contraseñas no coinciden.",
  next: "Continuar",
  back: "Atrás",
  finish: "Abrir mi clase",
  loading: "Preparando el asistente…",
  saving:
    "Creando el centro, preparando el modelo y guardando la primera clase… Puede tardar unos segundos.",
  error: "No se ha podido completar la configuración. Comprueba los datos y vuelve a intentarlo.",
  retry: "Volver a cargar",
  token: "Abre el enlace de configuración que aparece en la terminal de marea-teacher.",
  modelHelp: "Introduce la clave y busca el modelo que usará el alumnado.",
  modelRequired:
    "Elige una conexión y un modelo. Espera a que se compruebe la clave antes de continuar.",
  network: "¿Desde dónde se conectará el alumnado?",
  local: "Solo desde este ordenador",
  lan: "Desde la red local del aula (HTTP)",
  https: "Desde una dirección HTTPS",
  networkHelp:
    "HTTP permite trabajar en una red local de confianza. Para HTTPS necesitas una dirección con un proxy ya configurado.",
  port: "Puerto del servidor",
  origin: "Dirección HTTPS pública",
  identities: "Acceso con cuentas externas (opcional)",
  identityHelp:
    "Configura primero la aplicación en el proveedor de identidad. Después podrás dar acceso al alumnado desde los ajustes de la clase.",
  advanced: "Más opciones",
  testing: "Skill de ejemplo: aprender a escribir tests",
  review:
    "Se guardará la clase en modo tutoría, sin límites de uso y las modificaciones del proyecto sujetas a la aprobación del alumno.",
  optional:
    "Las cuentas externas y la skill de ejemplo son opcionales. La evaluación automática se puede configurar más adelante.",
  language: "Idioma",
  ready: "Configuración terminada. Abriendo tu panel…",
};
type Copy = {
  [K in keyof typeof es]: K extends "steps"
    ? readonly [string, string, string, string, string]
    : (typeof es)[K];
};
const en: Copy = {
  clearOptional: "Remove this optional configuration",
  school: "School and class",
  account: "Your teacher account",
  connectionOptions: "Connection options",
  change: "Change",
  skip: "Skip for now",
  map: "Attention map",
  mapHelp: "Helps identify students who may need your attention during class.",
  reports: "Class reports",
  reportsHelp: "Summarizes session evidence and difficulties for your review.",
  evaluation: "Automatic evaluation",
  evaluationHelp: "When a session closes, prepares a draft for you to review before sharing.",
  testingHelp:
    "Includes example goals and criteria for learning to test code. You can inspect and adapt it later.",
  usageHelp:
    "The map, reports and evaluation make additional requests to the chosen model. You can change their models and set limits in Settings → Server.",
  none: "None for now",
  address: "Student connection address",
  noAddress:
    "No network address detected. Connect this computer to the classroom network before sharing the installer.",

  title: "Prepare your first class",
  intro: "Get your first class ready to work. You can change these settings later.",
  steps: [
    "Your class",
    "Connect a model",
    "Give students access",
    "Optional features",
    "Review and start",
  ],
  center: "School name",
  classroom: "Name of your first class",
  teacher: "Your name",
  login: "Dashboard username",
  password: "Password",
  confirmation: "Repeat the password",
  passwordHelp: "Between 12 and 256 characters.",
  mismatch: "The passwords do not match.",
  next: "Continue",
  back: "Back",
  finish: "Open my class",
  loading: "Preparing setup…",
  saving:
    "Creating the school, preparing the model and saving the first class… This may take a few seconds.",
  error: "Setup could not be completed. Check the details and try again.",
  retry: "Reload",
  token: "Open the setup link shown in the marea-teacher terminal.",
  modelHelp: "Enter your key and find the model students will use.",
  modelRequired: "Choose a connection and model. Wait for the key check before continuing.",
  network: "Where will students connect from?",
  local: "Only this computer",
  lan: "The classroom local network (HTTP)",
  https: "An HTTPS address",
  networkHelp:
    "HTTP works on a trusted local network. HTTPS requires an address with a configured proxy.",
  port: "Server port",
  origin: "Public HTTPS address",
  identities: "External account sign-in (optional)",
  identityHelp:
    "Configure your application with the identity provider first. You can then grant student access in the class settings.",
  advanced: "More options",
  testing: "Example skill: learning to write tests",
  review:
    "The class will be saved in tutoring mode, without usage limits and project changes requiring the student's approval.",
  optional:
    "External accounts and the example skill are optional. Automatic evaluation can be configured later.",
  language: "Language",
  ready: "Setup complete. Opening your dashboard…",
};
const eu: Copy = {
  clearOptional: "Kendu aukerako konfigurazio hau",
  school: "Ikastetxea eta klasea",
  account: "Zure irakasle-kontua",
  connectionOptions: "Konexio-aukerak",
  change: "Aldatu",
  skip: "Saltatu oraingoz",
  map: "Arreta-mapa",
  mapHelp: "Klasean zure arreta behar dezaketen ikasleak identifikatzen laguntzen du.",
  reports: "Klaseko txostenak",
  reportsHelp: "Saioetako ebidentziak eta zailtasunak laburbiltzen ditu zure berrikuspenerako.",
  evaluation: "Ebaluazio automatikoa",
  evaluationHelp: "Saioa ixtean, partekatu aurretik berrikusiko duzun zirriborroa prestatzen du.",
  testingHelp:
    "Kodea probatzen ikasteko helburu eta irizpideen adibidea dakar. Gero ikusi eta molda dezakezu.",
  usageHelp:
    "Mapak, txostenek eta ebaluazioak kontsulta gehigarriak egiten dizkiote modeloari. Modeloak eta mugak Ezarpenak → Zerbitzaria atalean alda ditzakezu.",
  none: "Bat ere ez oraingoz",
  address: "Ikasleentzako konexio-helbidea",
  noAddress:
    "Ez da sare-helbiderik aurkitu. Konektatu ordenagailua ikasgelako sarera instalatzailea partekatu aurretik.",

  title: "Prestatu zure lehen klasea",
  intro: "Prestatu zure lehen klasea lanerako. Ezarpenak gero alda ditzakezu.",
  steps: [
    "Zure klasea",
    "Konektatu modelo bat",
    "Eman ikasleei sarbidea",
    "Aukerako funtzioak",
    "Berrikusi eta hasi",
  ],
  center: "Ikastetxearen izena",
  classroom: "Zure lehen klasearen izena",
  teacher: "Zure izena",
  login: "Paneleko erabiltzaile-izena",
  password: "Pasahitza",
  confirmation: "Errepikatu pasahitza",
  passwordHelp: "12 eta 256 karaktere artean.",
  mismatch: "Pasahitzak ez datoz bat.",
  next: "Jarraitu",
  back: "Atzera",
  finish: "Ireki nire klasea",
  loading: "Laguntzailea prestatzen…",
  saving:
    "Ikastetxea sortzen, modeloa prestatzen eta lehen klasea gordetzen… Segundo batzuk iraun dezake.",
  error: "Ezin izan da konfigurazioa osatu. Egiaztatu datuak eta saiatu berriro.",
  retry: "Kargatu berriro",
  token: "Ireki marea-teacher terminalean agertzen den konfigurazio-esteka.",
  modelHelp: "Sartu gakoa eta bilatu ikasleek erabiliko duten modeloa.",
  modelRequired: "Aukeratu konexioa eta modeloa. Itxaron gakoa egiaztatu arte jarraitzeko.",
  network: "Nondik konektatuko dira ikasleak?",
  local: "Ordenagailu honetatik soilik",
  lan: "Ikasgelako sare lokaletik (HTTP)",
  https: "HTTPS helbide batetik",
  networkHelp:
    "HTTP konfiantzazko sare lokal batean erabil daiteke. HTTPS erabiltzeko proxy bat konfiguratutako helbidea behar da.",
  port: "Zerbitzariaren ataka",
  origin: "HTTPS helbide publikoa",
  identities: "Kanpoko kontuekin sarbidea (aukerakoa)",
  identityHelp:
    "Konfiguratu aplikazioa identitate-hornitzailean. Ondoren, eman ikasleei sarbidea klasearen ezarpenetan.",
  advanced: "Aukera gehiago",
  testing: "Adibide-skilla: testak idazten ikastea",
  review:
    "Klasea tutoretza moduan gordeko da, erabilera-mugarik gabe eta proiektuko aldaketetarako ikaslearen onespena eskatuta.",
  optional:
    "Kanpoko kontuak eta adibide-skilla aukerakoak dira. Ebaluazio automatikoa gero konfigura daiteke.",
  language: "Hizkuntza",
  ready: "Konfigurazioa amaitu da. Panela irekitzen…",
};
export const setupMessages = (locale: DashboardLocale) => ({ es, en, eu })[locale];
