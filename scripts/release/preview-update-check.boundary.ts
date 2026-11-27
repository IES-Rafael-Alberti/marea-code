import { comparePreview, serverOrigin, type PreviewSettings } from "./preview-channel.js";
import {
  offeredVersion,
  requiredPreviewVersion,
  type PreviewFetch,
} from "./preview-download.boundary.js";

export interface UpdateCheck {
  /** The version to offer, if any check produced one. */
  readonly offered: string | undefined;
  /** The classroom server needs another protocol, so the offered version is mandatory. */
  readonly required: boolean;
  /** At least one check failed; its cause has already been written. */
  readonly failed: boolean;
}

interface UpdateCheckOptions {
  readonly settings: PreviewSettings;
  readonly current: string;
  readonly manual: boolean;
  readonly selectedVersion: string | undefined;
  readonly fetch?: PreviewFetch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
}

const certificateCode = /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS/u;

/** Bun's network failures carry a textual code; anything else has none (""). */
function errorCode(error: unknown): string {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : "";
}

/** The proxy variable Bun applies to this address, named but never printed with its value. */
function proxyVariable(url: string, environment: NodeJS.ProcessEnv): string | undefined {
  const names = url.startsWith("https:")
    ? ["HTTPS_PROXY", "https_proxy"]
    : ["HTTP_PROXY", "http_proxy"];
  return names.find((name) => (environment[name] ?? "").trim().length > 0);
}

/** Spanish cause of a failed check: timeout, no connection, proxy or invalid response. */
export function updateCheckCause(
  error: unknown,
  url: string,
  environment: NodeJS.ProcessEnv,
): string {
  const code = errorCode(error);
  const timeout = error instanceof Error && error.name === "TimeoutError";
  if (certificateCode.test(code))
    return "certificado no reconocido; puede que un proxy del centro intercepte la conexión";
  const network = timeout ? "tiempo agotado tras 2 s" : code === "" ? undefined : "sin conexión";
  if (network === undefined) {
    const status = /HTTP (\d{3})/u.exec(String(error))?.[1];
    return status === undefined ? "respuesta no válida" : `respuesta no válida (HTTP ${status})`;
  }
  const proxy = proxyVariable(url, environment);
  return proxy === undefined ? network : `fallo del proxy configurado en ${proxy} (${network})`;
}

/**
 * Asks the classroom server (protocol compatibility) and GitHub (published previews)
 * independently: one failing never hides the other, and each failure states its target and cause.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheck> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const { settings } = options;
  let failed = false;
  const attempt = async <T>(
    url: string,
    target: string,
    after: string,
    check: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await check();
    } catch (error) {
      failed = true;
      write(
        `No se ha podido consultar ${target} para buscar actualizaciones: ${updateCheckCause(error, url, environment)}.${after}\n`,
      );
      return undefined;
    }
  };
  let offered: string | undefined;
  if (!options.manual && settings.serverUrl !== undefined) {
    const origin = serverOrigin(settings.serverUrl);
    offered = await attempt(origin, `el servidor del aula (${origin})`, "", () =>
      requiredPreviewVersion(settings, options.current, fetcher),
    );
  }
  const required = offered !== undefined;
  offered ??=
    options.selectedVersion ??
    (await attempt(
      "https://raw.githubusercontent.com",
      "GitHub (raw.githubusercontent.com)",
      " Se conserva la versión instalada.",
      () => offeredVersion(settings, fetcher, options.manual ? "available" : "recommended"),
    ));
  return { offered, required, failed };
}

/** Whether the offered version should be proposed instead of starting the installed one. */
export function shouldOfferUpdate(
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
