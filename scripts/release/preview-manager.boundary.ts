import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { securePrivatePath } from "@marea/private-filesystem";
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
import { downloadPreview, offeredVersion } from "./preview-download.boundary.js";
import {
  activatePreviewServer,
  assertPreviewServerReady,
} from "./preview-server-update.boundary.js";
import {
  provisionServer,
  scaffoldServer,
  type RunPrivateCommand,
} from "./preview-setup.boundary.js";
import { acceptUpdate, question, serverQuestions } from "./preview-terminal.boundary.js";
import { runForeground } from "./preview-process.boundary.js";
import { configurePosixPath } from "./preview-path.boundary.js";
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
  try {
    await downloadPreview(settings, version, `${process.platform}-${process.arch}`, source, {
      fetch: globalThis.fetch,
      verify,
    });
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
          return activatePreviewServer(settings.installation, destination, version, activate);
        },
      },
    );
    return destination;
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

function writeLaunchers(root: string, selected: string): void {
  const bin = join(root, "bin");
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
    runPrivateCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',(${powershellLiteral(bin)}+';'+$p),'User')`,
    ]);
  } else {
    writeFileSync(join(bin, name), posixLauncher(root, selected), { flag: "wx", mode: 0o700 });
    if (configurePosixPath(homedir(), process.env.SHELL ?? "/bin/sh", bin))
      process.stdout.write(
        "La ruta de Marea se ha añadido a tu perfil. Abre una terminal nueva para usar el nombre corto.\n",
      );
    process.stdout.write(
      `Para usar el nombre corto en esta terminal: export PATH=${shellLiteral(bin)}:"$PATH"\n`,
    );
  }
  process.stdout.write(`Instalado: ${join(bin, name)}.\n`);
}

async function initialInstall(
  root: string,
  selected: "student" | "server",
  flags: Map<string, string>,
): Promise<void> {
  if (existsSync(root))
    throw new Error(
      "Preview root already exists; use its installed launcher to update. Existing installations are never adopted.",
    );
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
  const version = previewVersion.parse(flags.get("--version"));
  const cosign = flags.get("--cosign");
  if (cosign === undefined)
    throw new Error("Initial install needs the verified bootstrap signature tool");
  const setup = selected === "server" ? await serverQuestions() : undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  securePrivatePath(root, 0o700);
  privateDirectory(root);
  // A completion record is written last, so a partial setup cannot accidentally start a server.
  const release = await fetchAndInstall(root, settings, version, resolve(cosign));
  if (setup !== undefined) {
    scaffoldServer(requiredInstallation(settings), release, version, setup.answers);
    provisionServer(
      requiredInstallation(settings),
      release,
      setup.answers,
      setup.password,
      runPrivateCommand,
    );
    process.stdout.write(
      `Abre ${setup.answers.origin}/dashboard/ y entra como ${setup.answers.login}. Configura el proveedor y modelo en Ajustes → Servidor y guarda la configuración docente de la clase.\n`,
    );
  }
  writeLaunchers(root, selected);
  writeFileSync(join(root, "preview.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
}

function managedEnvironment(root: string, settings: PreviewSettings): NodeJS.ProcessEnv {
  const server = (process.env.MAREA_SERVER_URL ?? "").trim();
  const stateHome = (process.env.MAREA_STATE_HOME ?? "").trim();
  return {
    ...process.env,
    MAREA_SERVER_URL: server.length > 0 ? server : settings.serverUrl,
    MAREA_STATE_HOME: stateHome.length > 0 ? stateHome : join(root, "student-state"),
  };
}

async function updateBeforeStart(
  root: string,
  settings: PreviewSettings,
  release: string,
  current: string,
): Promise<string> {
  let offered: string | undefined;
  try {
    offered = await offeredVersion(
      {
        ...settings,
        ...(settings.component === "student" && process.env.MAREA_SERVER_URL
          ? { serverUrl: serverOrigin(process.env.MAREA_SERVER_URL) }
          : {}),
      },
      current,
      globalThis.fetch,
    );
  } catch {
    process.stderr.write(
      "No se ha podido comprobar la actualización; se conserva la versión instalada.\n",
    );
  }
  if (
    offered !== undefined &&
    (settings.component === "student"
      ? offered !== current
      : comparePreview(offered, current) > 0) &&
    (await acceptUpdate(offered))
  )
    try {
      return await fetchAndInstall(
        root,
        settings,
        offered,
        join(release, `cosign${executableSuffix()}`),
      );
    } catch {
      if (settings.installation !== undefined) assertPreviewServerReady(settings.installation);
      process.stderr.write("No se ha podido actualizar; se conserva la instalación verificada.\n");
      process.exitCode = 1;
      return activeRelease(root);
    }
  return release;
}

export async function previewMain(argv: readonly string[]): Promise<void> {
  const request = parsePreviewArguments(argv);
  if (request.forwarded.includes("--help") || request.forwarded.includes("-h")) {
    process.stdout.write(
      "Marea preview: --version, --status, --update. Run without these options to start.\n",
    );
    return;
  }
  if (request.forwarded[0] === "--status") request.action = "status";
  if (request.forwarded[0] === "--update") request.action = "update";
  const root = resolve(
    request.flags.get("--root") ?? join(homedir(), ".marea-preview", request.selected),
  );
  if (request.action === "install") return initialInstall(root, request.selected, request.flags);
  privateDirectory(root);
  const settings = previewSettingsSchema.parse(
    JSON.parse(readFileSync(join(root, "preview.json"), "utf8")),
  );
  if (settings.component !== request.selected) throw new Error("Component selection mismatch");
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
  if (settings.installation !== undefined) assertPreviewServerReady(settings.installation);
  release = await updateBeforeStart(root, settings, release, current);
  if (request.action === "update") return;
  const binary = join(
    release,
    `${settings.component === "student" ? "marea" : "marea-teacher"}${executableSuffix()}`,
  );
  const args =
    settings.component === "student"
      ? request.forwarded
      : [
          "--installation",
          requiredInstallation(settings),
          "--release",
          assertPreviewServerReady(requiredInstallation(settings)),
        ];
  process.exitCode = await runForeground(binary, args, managedEnvironment(root, settings));
}
