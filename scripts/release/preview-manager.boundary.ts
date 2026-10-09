import { parseServerArguments } from "../../apps/student/src/server-arguments.js";
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
  comparePreview,
  previewSettingsSchema,
  previewVersion,
  repositoryName,
  serverOrigin,
  type PreviewSettings,
} from "./preview-channel.js";
import {
  downloadPreview,
  offeredVersion,
  requiredPreviewVersion,
} from "./preview-download.boundary.js";
import {
  activatePreviewServer,
  assertPreviewServerReady,
} from "./preview-server-update.boundary.js";
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

function managedEnvironment(root: string, settings: PreviewSettings): NodeJS.ProcessEnv {
  const stateHome = (process.env.MAREA_STATE_HOME ?? "").trim();
  return {
    ...process.env,
    MAREA_SERVER_URL: settings.serverUrl,
    MAREA_STATE_HOME: stateHome.length > 0 ? stateHome : join(root, "student-state"),
  };
}

function shouldOfferUpdate(
  settings: PreviewSettings,
  offered: string,
  current: string,
  required: boolean,
  selectedVersion: string | undefined,
): boolean {
  const comparison = comparePreview(offered, current);
  if (comparison === 0) {
    if (required)
      throw new Error(
        "El servidor anuncia un protocolo incompatible para la misma versión. Contacta con el administrador.",
      );
    return false;
  }
  if (comparison === -1 && settings.component === "server") {
    if (selectedVersion !== undefined)
      throw new Error(
        "Server downgrades require backup recovery; an older executable cannot open migrated data.",
      );
    return false;
  }
  if (comparison === -1 && !required && selectedVersion === undefined) return false;
  return true;
}

async function updateBeforeStart(
  root: string,
  settings: PreviewSettings,
  release: string,
  current: string,
  manual: boolean,
  selectedVersion?: string,
): Promise<string> {
  let offered: string | undefined;
  let required = false;
  try {
    if (!manual) {
      offered = await requiredPreviewVersion(settings, current, globalThis.fetch);
      required = offered !== undefined;
    }
    offered ??=
      selectedVersion ??
      (await offeredVersion(settings, globalThis.fetch, manual ? "available" : "recommended"));
  } catch {
    process.stderr.write(
      "No se ha podido comprobar la actualización; se conserva la versión instalada.\n",
    );
    process.exitCode = 1;
    return release;
  }
  if (offered === undefined) return release;
  if (!shouldOfferUpdate(settings, offered, current, required, selectedVersion)) return release;
  if (!(await acceptUpdate(offered, required))) {
    if (required)
      throw new Error(
        `El servidor requiere un protocolo compatible. Instala Marea ${offered} para conectarte.`,
      );
    return release;
  }
  try {
    return await fetchAndInstall(
      root,
      settings,
      offered,
      join(release, `cosign${executableSuffix()}`),
    );
  } catch {
    if (settings.installation !== undefined && !onboardingPending(root))
      assertPreviewServerReady(settings.installation);
    if (required)
      throw new Error(
        `No se ha podido instalar la versión ${offered} necesaria para este servidor.`,
      );
    process.stderr.write("No se ha podido actualizar; se conserva la instalación verificada.\n");
    process.exitCode = 1;
    return activeRelease(root);
  }
}

function selectedServerSettings(
  settings: PreviewSettings,
  forwarded: readonly string[],
): PreviewSettings {
  if (settings.component !== "student") return settings;
  const parsed = parseServerArguments(forwarded);
  if (parsed === undefined) throw new Error("Use --server <http(s)://host:port> once");
  const url =
    parsed.serverUrl ?? ((process.env.MAREA_SERVER_URL ?? "").trim() || settings.serverUrl);
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
  let release = activeRelease(root);
  const current = previewVersion.parse(
    manifestSchema.parse(JSON.parse(readFileSync(join(release, "manifest.json"), "utf8"))).version,
  );
  if (request.forwarded[0] === "--version") {
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
  const selectedSettings = selectedServerSettings(settings, request.forwarded);
  release = await updateBeforeStart(
    root,
    selectedSettings,
    release,
    current,
    request.action === "update",
    request.flags.get("--version"),
  );
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
