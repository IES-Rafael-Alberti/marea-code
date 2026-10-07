import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { securePrivatePath } from "@marea/private-filesystem";
import { loadFileSystemDashboardAssets } from "../../apps/teacher-server/src/dashboard-assets/filesystem-dashboard-assets.boundary.js";
import { createDashboardAssetHandler } from "../../apps/teacher-server/src/dashboard-assets/dashboard-asset-handler.js";
import { openSystemBrowser } from "../../apps/student/src/external-authorization.boundary.js";
import { assertPreviewServerReady } from "./preview-server-update.boundary.js";
import { previewSettingsSchema, type PreviewSettings } from "./preview-channel.js";
import type { RunPrivateCommand } from "./preview-setup.boundary.js";
import { onboardingHttp } from "./onboarding-http.boundary.js";
import { onboardingSettings } from "./onboarding-settings.boundary.js";
import { provisionOnboarding, relocateOnboarding } from "./onboarding-provision.boundary.js";
import {
  existingOnboarding,
  onboardingMarker,
  ownOnboarding,
} from "./onboarding-state.boundary.js";
import { InstallerUsageError } from "./installer-cli.boundary.js";
import { waitForOnboardingHost, checkOnboardingPort } from "./onboarding-host.boundary.js";
import { onboardingSignIn } from "./onboarding-signin.boundary.js";

async function setupAssets(release: string) {
  const root = join(release, "dashboard");
  const assets = await loadFileSystemDashboardAssets(root);
  const path = join(root, "setup.html");
  if (!lstatSync(path).isFile()) throw new Error("Missing setup page");
  const page = {
    body: new Blob([readFileSync(path)]),
    contentType: "text/html; charset=utf-8",
    entityTag: '"setup"',
    immutable: false,
  };
  return createDashboardAssetHandler({
    find: (name) => (name === "setup.html" ? page : assets.find(name)),
  });
}

/** The installed launcher owns setup; the school host is still the ordinary compiled executable. */
export async function runBrowserOnboarding(options: {
  root: string;
  release: string;
  version: string;
  settings: PreviewSettings;
  run: RunPrivateCommand;
  launch: (allowHttp: boolean) => Promise<number>;
  openBrowser?: (url: string) => void;
}): Promise<number> {
  const { root, release, version, settings } = options;
  const openBrowser = options.openBrowser ?? openSystemBrowser;
  const existing = existingOnboarding(root);
  if (existing !== null) {
    openBrowser(existing);
    process.stdout.write(`El asistente ya está abierto: ${existing}\n`);
    return 0;
  }
  const installation = join(root, "installation");
  if (settings.installation !== installation) throw new Error("Unexpected managed installation");
  // A crash after promotion and before marker removal already left a complete installation.
  if (existsSync(installation)) {
    assertPreviewServerReady(installation);
    rmSync(join(root, onboardingMarker));
    return options.launch(settings.allowHttp === true);
  }
  const assets = await setupAssets(release);
  const token = randomBytes(32).toString("base64url");
  const configured = Promise.withResolvers<{ dashboardUrl: string; allowHttp: boolean }>();
  const hostReady = Promise.withResolvers<undefined>();
  // A failed/cancelled host may arrive before the pending HTTP handler awaits readiness.
  void hostReady.promise.catch(() => undefined);
  const service = onboardingSettings();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 180,
    fetch: (request) => handler(request),
  });
  const url = `${server.url.origin}/dashboard/setup.html#token=${token}`;
  let owner: ReturnType<typeof ownOnboarding>;
  try {
    owner = ownOnboarding(root, url);
    securePrivatePath(owner.stage, 0o700);
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  const cancelled = new AbortController();
  let provisioning: Promise<unknown> = Promise.resolve();
  const handler = onboardingHttp({
    origin: () => server.url.origin,
    token,
    assets: (request) => Promise.resolve(assets(request)),
    read: service.read,
    models: (input, signal) => service.models(input, signal),
    finish(input, signal) {
      const result = (async () => {
        const validated = await service.validate(
          input,
          AbortSignal.any([signal, cancelled.signal]),
        );
        await checkOnboardingPort(input.port, input.access === "lan");
        cancelled.signal.throwIfAborted();
        process.stderr.write(
          "Creando el centro, configurando el modelo y guardando la primera clase...\n",
        );
        // A previous rejected attempt left only this process's own disposable staging tree.
        rmSync(owner.stage, { recursive: true, force: true });
        await provisionOnboarding(owner.stage, release, version, validated, options.run);
        cancelled.signal.throwIfAborted();
        relocateOnboarding(owner.stage, installation);
        if (existsSync(installation)) throw new Error("Installation appeared during setup");
        const temporary = join(root, `preview.${randomUUID()}.tmp`);
        writeFileSync(
          temporary,
          JSON.stringify(
            previewSettingsSchema.parse({ ...settings, allowHttp: input.access === "lan" }),
          ),
          { flag: "wx", mode: 0o600 },
        );
        renameSync(temporary, join(root, "preview.json"));
        renameSync(owner.stage, installation);
        rmSync(join(root, onboardingMarker));
        const dashboardUrl = `${validated.origin}/dashboard/`;
        configured.resolve({ dashboardUrl, allowHttp: input.access === "lan" });
        await hostReady.promise;
        const cookie = await onboardingSignIn(input);
        // Let the completed response reach the browser before closing the private setup listener.
        setTimeout(() => {
          void server.stop(false);
        }, 1000);
        return cookie === undefined ? { dashboardUrl } : { dashboardUrl, cookie };
      })();
      provisioning = result.catch(() => undefined);
      return result;
    },
  });
  const cancel = () => {
    cancelled.abort();
    configured.reject(
      new InstallerUsageError(
        "Configuración cancelada. Ejecuta marea-teacher para abrir de nuevo el asistente.",
      ),
    );
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  process.stdout.write(`Completa la configuración en tu navegador: ${url}\n`);
  openBrowser(url);
  try {
    const prepared = await configured.promise;
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    const stopped = new AbortController();
    const running = options.launch(prepared.allowHttp).finally(() => {
      stopped.abort();
    });
    void running.catch(() => undefined);
    try {
      await waitForOnboardingHost(installation, prepared.dashboardUrl, stopped.signal);
      hostReady.resolve(undefined);
    } catch (error) {
      hostReady.reject(error);
    }
    return await running;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await provisioning;
    await server.stop(true);
    owner.close();
  }
}
