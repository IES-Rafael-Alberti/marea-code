import { InstallerUsageError } from "./installer-cli.boundary.js";

export class DownloadResponseError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

/** Retry transport failures only; signature and checksum validation happens outside this loop. */
export async function retryReleaseDownload<T>(
  name: string,
  download: () => Promise<T>,
  report: (message: string) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await download();
    } catch (error) {
      const response = error instanceof DownloadResponseError ? error : undefined;
      if (attempt === 4 || response?.retryable === false)
        throw new InstallerUsageError(
          `No se pudo descargar ${name} (${response?.message ?? "fallo de conexión"}). Vuelve a ejecutar el comando de instalación. No se ha activado una versión incompleta.`,
        );
      const delay = Math.max(1000 * 2 ** (attempt - 1), response?.retryAfterMs ?? 0);
      report(
        `Descarga interrumpida: ${name}. Reintentando (${String(attempt + 1)}/4) en ${String(delay / 1000)} s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
