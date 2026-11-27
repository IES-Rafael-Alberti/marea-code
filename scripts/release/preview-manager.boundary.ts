import { parseSavedServer, SAVED_SERVER_FILE } from "../../apps/student/src/saved-server.js";
import { parseServerArguments } from "../../apps/student/src/server-arguments.js";
import { OperatorCliError } from "../../apps/teacher-server/src/platform/operator-cli/errors.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
import { uninstallPreview } from "./preview-uninstall.boundary.js";
import { preparePreviewRoot } from "./preview-existing.boundary.js";
import { installPreviewAtomically } from "./preview-install-transaction.boundary.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { component, manifestSchema } from "./manifest.js";
import {
  installRelease,
  privateDirectory,
  readActivation,
  verifySignature,
} from "./install.boundary.js";
import {
  previewSettingsSchema,
  previewVersion,
  repositoryName,
  serverOrigin,
  type PreviewSettings,
} from "./preview-channel.js";
import { downloadPreview, offeredVersion } from "./preview-download.boundary.js";
import { checkForUpdate, shouldOfferUpdate } from "./preview-update-check.boundary.js";
import {
  activatePreviewServer,
  assertPreviewServerIdle,
  assertPreviewServerReady,
  recoverInterruptedPreviewUpdate,
} from "./preview-server-update.boundary.js";
import { UpdateRolledBackError } from "./preview-update-rolled-back.js";
import { type RunPrivateCommand } from "./preview-setup.boundary.js";
import { acceptUpdate, question } from "./preview-terminal.boundary.js";
import { markOnboardingPending, onboardingPending } from "./onboarding-state.boundary.js";
import { runBrowserOnboarding } from "./preview-onboarding.boundary.js";
import { runForeground } from "./preview-process.boundary.js";
import { configurePosixPath } from "./preview-path.boundary.js";
import { installationProgress } from "./preview-progress.boundary.js";
import {
  posixLauncher,
  powershellLiteral,
  shellLiteral,
  windowsLauncher,
} from "./preview-launchers.js";

const executableSuffix = () => (process.platform === "win32" ? ".exe" : "");

export const runPrivateCommand: RunPrivateCommand = (binary, args, input) => {
  const result = spawnSync(binary, args, { input, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0)
    throw new Error(
      `Setup command failed: ${args.slice(2, 4).join(" ")} (exit ${String(result.status)}). Private details were not printed.`,
    );
  return result.stdout;
};

export function parsePreviewArguments(argv: readonly string[]) {
  const [action, selected, ...rest] = argv;
  if (!["install", "run", "update", "status"].includes(String(action)))
    throw new Error("Use preview install/run/update/status student/server");
  const flags = new Map<string, string>();
  let index = 0;
  for (; index < rest.length && rest[index] !== "--"; index += 2) {
    const key = String(rest[index]);
    const value = rest[index + 1];
    if (
      !["--root", "--repository", "--version", "--cosign", "--server"].includes(key) ||
      !value ||
      flags.has(key)
    )
      throw new Error("Invalid preview arguments");
    flags.set(key, value);
  }
  return {
    action: String(action),
    selected: component.parse(selected),
    flags,
    forwarded: rest.slice(index + 1),
  };
}

function requiredInstallation(settings: PreviewSettings): string {
  if (settings.installation === undefined) throw new Error("Missing server installation");
  return settings.installation;
}

function activeRelease(root: string): string {
  const activation = readActivation(join(root, "programs"));
  if (activation === null) throw new Error("No active preview installation");
  return join(root, "programs", activation.current);
}

async function fetchAndInstall(
  root: string,
  settings: PreviewSettings,
  version: string,
  cosign: string,
): Promise<string> {
  const source = mkdtempSync(join(root, ".download-"));
  const destination = join(
    root,
    "programs",
    `${settings.component}-${previewVersion.parse(version)}`,
  );
  const verify = (manifest: string, bundle: string, identity: string) => {
    verifySignature(manifest, bundle, identity, cosign);
  };
  const progress = installationProgress();
  try {
    await downloadPreview(settings, version, `${process.platform}-${process.arch}`, source, {
      fetch: globalThis.fetch,
      reuseDirectory: dirname(cosign),
      verify,
      progress,
    });
    progress.stage("Instalando los archivos verificados...");
    await installRelease(
      {
        source,
        root: join(root, "programs"),
        version,
        component: settings.component,
        repository: settings.repository,
        ref: `refs/tags/v${version}`,
        reuseVerifiedStudent: settings.component === "student",
      },
      {
        verifySignature: verify,
        privateDirectory,
        withOfflineBackup: (activate) => {
          if (settings.installation === undefined) throw new Error("Missing server installation");
          if (onboardingPending(root) && !existsSync(settings.installation)) return activate();
          return activatePreviewServer(settings.installation, destination, version, activate);
        },
      },
    );
    return destination;
  } finally {
    progress.finish();
    rmSync(source, { recursive: true, force: true });
  }
}

function writeLaunchers(stage: string, root: string, selected: string): void {
  const bin = join(stage, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const name = selected === "student" ? "marea" : "marea-teacher";
  if (process.platform === "win32") {
    writeFileSync(join(bin, `${name}.ps1`), windowsLauncher(root, selected), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      join(bin, `${name}.cmd`),
      `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${name}.ps1" %*\r\n`,
      { flag: "wx", mode: 0o600 },
    );
  } else {
    writeFileSync(join(bin, name), posixLauncher(root, selected), { flag: "wx", mode: 0o700 });
  }
}

function configureInstalledPath(root: string, selected: string): void {
  const bin = join(root, "bin");
  const name = selected === "student" ? "marea" : "marea-teacher";
  process.stdout.write(`Instalado: ${join(bin, name)}.\n`);
  if (process.platform === "win32") {
    runPrivateCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',(${powershellLiteral(bin)}+';'+$p),'User')`,
    ]);
  } else {
    if (configurePosixPath(homedir(), process.env.SHELL ?? "/bin/sh", bin))
      process.stdout.write(
        "La ruta de Marea se ha añadido a tu perfil. Abre una terminal nueva para usar el nombre corto.\n",
      );
    process.stdout.write(
      `Para usar el nombre corto en esta terminal: export PATH=${shellLiteral(bin)}:"$PATH"\n`,
    );
  }
}

async function initialInstall(
  root: string,
  selected: "student" | "server",
  flags: Map<string, string>,
): Promise<void> {
  if (!(await preparePreviewRoot(root, selected))) return;
  const settings: PreviewSettings = previewSettingsSchema.parse({
    format: 1,
    repository: repositoryName.parse(flags.get("--repository")),
    component: selected,
    channel: "preview",
    ...(selected === "server"
      ? { installation: join(root, "installation") }
      : {
          serverUrl: serverOrigin(
            flags.get("--server") ?? (await question("Dirección del servidor del centro")),
          ),
        }),
  });
  const recommended = flags.get("--version") ?? (await offeredVersion(settings, globalThis.fetch));
  if (recommended === undefined)
    throw new Error(
      "No recommended preview. Use --version with a published preview for a pilot installation.",
    );
  const version = previewVersion.parse(recommended);
  const cosign = flags.get("--cosign");
  if (cosign === undefined)
    throw new Error("Initial install needs the verified bootstrap signature tool");
  await installPreviewAtomically(root, async (stage) => {
    await fetchAndInstall(stage, settings, version, resolve(cosign));
    if (selected === "server") markOnboardingPending(stage);
    writeFileSync(join(stage, "preview.json"), JSON.stringify(settings), {
      flag: "wx",
      mode: 0o600,
    });
    writeLaunchers(stage, root, selected);
  });
  if (selected === "server") {
    process.stdout.write(
      "Ejecuta marea-teacher: se abrirá un asistente en tu navegador para dejar la primera clase lista.\n",
    );
  }
  try {
    configureInstalledPath(root, selected);
  } catch {
    process.stderr.write(
      `Marea está instalado, pero no se ha podido añadir el comando al PATH. Puedes ejecutarlo desde ${join(root, "bin")} o añadir esa carpeta al PATH manualmente.\n`,
    );
  }
}

function studentStateHome(root: string): string {
  const stateHome = (process.env.MAREA_STATE_HOME ?? "").trim();
  return stateHome.length > 0 ? stateHome : join(root, "student-state");
}

function managedEnvironment(root: string, settings: PreviewSettings): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MAREA_SERVER_URL: settings.serverUrl,
    MAREA_STATE_HOME: studentStateHome(root),
  };
}

/** The saved server, or undefined when missing, corrupt or unusable (serverOrigin then throws). */
function savedServerOrigin(root: string): string | undefined {
  try {
    const text = readFileSync(join(studentStateHome(root), SAVED_SERVER_FILE), "utf8");
    // Stryker disable next-line StringLiteral: any non-URL fallback makes serverOrigin throw alike.
    return serverOrigin(parseSavedServer(text) ?? "");
  } catch {
    // The installed server stays in charge.
  }
  return undefined;
}

/** `-v` is `--version`: the installed release, printed without any network check. */
const asksVersion = (forwarded: readonly string[]) =>
  ["--version", "-v"].includes(String(forwarded[0]));

/** Commands that only talk to the student's own state or account never check for updates. */
const skipsUpdateCheck = (forwarded: readonly string[]) =>
  ["feedback", "logout"].includes(String(forwarded[0]));

async function updateBeforeStart(
  root: string,
  settings: PreviewSettings,
  release: string,
  current: string,
  request: {
    readonly action: string;
    readonly flags: ReadonlyMap<string, string>;
    readonly forwarded: readonly string[];
  },
): Promise<string> {
  if (skipsUpdateCheck(request.forwarded)) return release;
  const manual = request.action === "update";
  const selectedVersion = request.flags.get("--version");
  const { offered, required, failed } = await checkForUpdate({
    settings,
    current,
    manual,
    selectedVersion,
  });
  if (failed) process.exitCode = 1;
  if (
    offered === undefined ||
    !shouldOfferUpdate(settings, offered, current, required, selectedVersion)
  ) {
    if (manual && !failed && selectedVersion === undefined)
      process.stdout.write(`Marea ya está en la última versión (${current}).\n`);
    return release;
  }
  if (!(await acceptUpdate(offered, required))) {
    if (required)
      throw new Error(
        `El servidor requiere un protocolo compatible. Instala Marea ${offered} para conectarte.`,
      );
    return release;
  }
  try {
    if (settings.installation !== undefined && !onboardingPending(root))
      await assertPreviewServerIdle(settings.installation);
    return await fetchAndInstall(
      root,
      settings,
      offered,
      join(release, `cosign${executableSuffix()}`),
    );
  } catch (error) {
    if (settings.installation !== undefined && !onboardingPending(root))
      assertReadyAfterFailure(settings.installation, error);
    if (required)
      throw new InstallerUsageError(
        `No se ha podido instalar la versión ${offered} necesaria para este servidor.`,
      );
    process.stderr.write(updateFailureMessage(error));
    process.exitCode = 1;
    return activeRelease(root);
  }
}

function reportRecoveredUpdate(recovered: boolean | undefined): void {
  if (recovered === true)
    process.stderr.write(
      "Una actualización anterior se interrumpió antes de modificar los datos. Se ha vuelto a la versión anterior; puedes reintentar con marea-teacher update.\n",
    );
}

function recoverBeforeLaunch(
  root: string,
  settings: PreviewSettings,
  request: { readonly action: string; readonly forwarded: readonly string[] },
): void {
  if (
    settings.installation !== undefined &&
    request.action !== "status" &&
    !asksVersion(request.forwarded) &&
    !onboardingPending(root)
  )
    reportRecoveredUpdate(recoverInterruptedPreviewUpdate(settings.installation));
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed update must not hide its own cause behind the readiness error it may have caused. */
function assertReadyAfterFailure(installation: string, failure: unknown): void {
  try {
    assertPreviewServerReady(installation);
  } catch (readiness) {
    throw new Error(
      `${failureReason(readiness)} Cause of the failed update: ${failureReason(failure)}`,
      { cause: readiness },
    );
  }
}

function updateFailureMessage(error: unknown): string {
  if (error instanceof UpdateRolledBackError)
    return `La actualización ha fallado y se ha vuelto a la versión anterior, que sigue funcionando. Los datos no se han modificado. Causa: ${error.message}. Puedes reintentar con marea-teacher update.\n`;
  if (error instanceof OperatorCliError && error.code === "installation-busy")
    return "La instalación sigue bloqueada. Cierra el servidor si está en marcha y vuelve a ejecutar marea-teacher update para revisar el bloqueo. Se conserva la versión instalada.\n";
  return `No se ha podido actualizar; se conserva la instalación verificada. Causa: ${failureReason(error)}\n`;
}

/** The same server the student will connect to: --server, then the saved one, then the install. */
function selectedServerSettings(
  root: string,
  settings: PreviewSettings,
  forwarded: readonly string[],
): PreviewSettings {
  if (settings.component !== "student") return settings;
  const parsed = parseServerArguments(forwarded);
  if (parsed === undefined) throw new Error("Use --server <http(s)://host:port> once");
  const url =
    parsed.serverUrl ??
    savedServerOrigin(root) ??
    ((process.env.MAREA_SERVER_URL ?? "").trim() || settings.serverUrl);
  return url === undefined ? settings : { ...settings, serverUrl: serverOrigin(url) };
}

export async function previewMain(argv: readonly string[]): Promise<void> {
  const request = parsePreviewArguments(argv);
  if (request.forwarded.includes("--help") || request.forwarded.includes("-h")) {
    process.stdout.write(
      "Marea preview: --version, status, update [--version X.Y.Z-preview.N], uninstall [--yes] [--purge-data]. Start with --server <http(s)://host:port> (student) or --allow-http (server).\n",
    );
    return;
  }
  if (["status", "--status"].includes(String(request.forwarded[0]))) request.action = "status";
  if (["update", "--update"].includes(String(request.forwarded[0]))) {
    request.action = "update";
    const options = request.forwarded.slice(1);
    if (options.length !== 0) {
      if (options.length !== 2 || options[0] !== "--version")
        throw new Error("Use update [--version X.Y.Z-preview.N]");
      request.flags.set("--version", previewVersion.parse(options[1]));
    }
  }
  const root = resolve(
    request.flags.get("--root") ?? join(homedir(), ".marea-preview", request.selected),
  );
  if (request.action === "install") return initialInstall(root, request.selected, request.flags);
  privateDirectory(root);
  const settings = previewSettingsSchema.parse(
    JSON.parse(readFileSync(join(root, "preview.json"), "utf8")),
  );
  if (settings.component !== request.selected) throw new Error("Component selection mismatch");
  if (request.forwarded[0] === "uninstall")
    return uninstallPreview(root, settings, request.forwarded.slice(1));
  recoverBeforeLaunch(root, settings, request);
  let release = activeRelease(root);
  const current = previewVersion.parse(
    manifestSchema.parse(JSON.parse(readFileSync(join(release, "manifest.json"), "utf8"))).version,
  );
  if (asksVersion(request.forwarded)) {
    process.stdout.write(`${current}\n`);
    return;
  }
  if (request.action === "status") {
    process.stdout.write(`${JSON.stringify({ version: current, ...settings })}\n`);
    return;
  }
  const pending = settings.component === "server" && onboardingPending(root);
  const launchServer = (allowHttp: boolean) =>
    runForeground(
      join(release, `marea-teacher${executableSuffix()}`),
      [
        "--installation",
        requiredInstallation(settings),
        "--release",
        assertPreviewServerReady(requiredInstallation(settings)),
        ...request.forwarded,
        ...(allowHttp && !request.forwarded.includes("--allow-http") ? ["--allow-http"] : []),
      ],
      managedEnvironment(root, settings),
    );
  if (pending && request.action === "run") {
    process.exitCode = await runBrowserOnboarding({
      root,
      release,
      version: current,
      settings,
      run: runPrivateCommand,
      launch: launchServer,
    });
    return;
  }
  if (settings.installation !== undefined && !pending)
    assertPreviewServerReady(settings.installation);
  const selectedSettings = selectedServerSettings(root, settings, request.forwarded);
  release = await updateBeforeStart(root, selectedSettings, release, current, request);
  if (request.action === "update") return;
  if (settings.component === "server") {
    process.exitCode = await launchServer(settings.allowHttp === true);
    return;
  }
  const binary = join(release, `marea${executableSuffix()}`);
  process.exitCode = await runForeground(
    binary,
    request.forwarded,
    managedEnvironment(root, selectedSettings),
  );
}
