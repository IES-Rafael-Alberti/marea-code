import type { DashboardLocale } from "../messages.js";

const es = {
  title: "Bienvenido a Marea Code",
  intro: "Deja tu primera clase lista para trabajar. Podrás cambiar estos ajustes después.",
  steps: ["Tu centro", "Conexión y modelo", "Acceso al aula", "Todo listo"],
  center: "Nombre del centro",
  classroom: "Primera clase",
  teacher: "Tu nombre",
  login: "Usuario para entrar al panel",
  password: "Contraseña",
  confirmation: "Repite la contraseña",
  passwordHelp: "Entre 12 y 256 caracteres.",
  mismatch: "Las contraseñas no coinciden.",
  next: "Continuar",
  back: "Atrás",
  finish: "Crear centro y abrir el panel",
  loading: "Preparando el asistente…",
  saving:
    "Creando el centro, preparando el modelo y guardando la primera clase… Puede tardar unos segundos.",
  error: "No se ha podido completar la configuración. Comprueba los datos y vuelve a intentarlo.",
  retry: "Volver a cargar",
  token: "Abre el enlace de configuración que aparece en la terminal de marea-teacher.",
  modelHelp:
    "Introduce la clave de tu proveedor y elige el modelo que usará el alumnado. Se comprobará la conexión y se completarán sus precios.",
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
  testing: "Activar la skill de ejemplo para aprender a escribir tests (opcional)",
  review:
    "Se guardará la clase en modo tutoría, con los límites elegidos y las modificaciones del proyecto sujetas a la aprobación del alumno.",
  optional:
    "Las cuentas externas y la skill de ejemplo son opcionales. La evaluación automática se puede configurar más adelante.",
  language: "Idioma",
  ready: "Configuración terminada. Abriendo tu panel…",
};
type Copy = { [K in keyof typeof es]: (typeof es)[K] };
const en: Copy = {
  title: "Welcome to Marea Code",
  intro: "Get your first class ready to work. You can change these settings later.",
  steps: ["Your school", "Connection and model", "Classroom access", "Ready to start"],
  center: "School name",
  classroom: "First class",
  teacher: "Your name",
  login: "Dashboard username",
  password: "Password",
  confirmation: "Repeat the password",
  passwordHelp: "Between 12 and 256 characters.",
  mismatch: "The passwords do not match.",
  next: "Continue",
  back: "Back",
  finish: "Create school and open dashboard",
  loading: "Preparing setup…",
  saving:
    "Creating the school, preparing the model and saving the first class… This may take a few seconds.",
  error: "Setup could not be completed. Check the details and try again.",
  retry: "Reload",
  token: "Open the setup link shown in the marea-teacher terminal.",
  modelHelp:
    "Enter your provider key and choose the model students will use. The connection will be checked and its prices filled in.",
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
  testing: "Enable the example skill for learning to write tests (optional)",
  review:
    "The class will be saved in tutoring mode, with the selected limits and project changes requiring the student's approval.",
  optional:
    "External accounts and the example skill are optional. Automatic evaluation can be configured later.",
  language: "Language",
  ready: "Setup complete. Opening your dashboard…",
};
const eu: Copy = {
  title: "Ongi etorri Marea Code-ra",
  intro: "Prestatu zure lehen klasea lanerako. Ezarpenak gero alda ditzakezu.",
  steps: ["Zure ikastetxea", "Konexioa eta modeloa", "Ikasgelarako sarbidea", "Hasteko prest"],
  center: "Ikastetxearen izena",
  classroom: "Lehen klasea",
  teacher: "Zure izena",
  login: "Paneleko erabiltzaile-izena",
  password: "Pasahitza",
  confirmation: "Errepikatu pasahitza",
  passwordHelp: "12 eta 256 karaktere artean.",
  mismatch: "Pasahitzak ez datoz bat.",
  next: "Jarraitu",
  back: "Atzera",
  finish: "Sortu ikastetxea eta ireki panela",
  loading: "Laguntzailea prestatzen…",
  saving:
    "Ikastetxea sortzen, modeloa prestatzen eta lehen klasea gordetzen… Segundo batzuk iraun dezake.",
  error: "Ezin izan da konfigurazioa osatu. Egiaztatu datuak eta saiatu berriro.",
  retry: "Kargatu berriro",
  token: "Ireki marea-teacher terminalean agertzen den konfigurazio-esteka.",
  modelHelp:
    "Sartu hornitzailearen gakoa eta aukeratu ikasleek erabiliko duten modeloa. Konexioa egiaztatu eta prezioak beteko dira.",
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
  testing: "Aktibatu testak idazten ikasteko adibide-skilla (aukerakoa)",
  review:
    "Klasea tutoretza moduan gordeko da, hautatutako mugekin eta proiektuko aldaketetarako ikaslearen onespena eskatuta.",
  optional:
    "Kanpoko kontuak eta adibide-skilla aukerakoak dira. Ebaluazio automatikoa gero konfigura daiteke.",
  language: "Hizkuntza",
  ready: "Konfigurazioa amaitu da. Panela irekitzen…",
};
export const setupMessages = (locale: DashboardLocale) => ({ es, en, eu })[locale];
