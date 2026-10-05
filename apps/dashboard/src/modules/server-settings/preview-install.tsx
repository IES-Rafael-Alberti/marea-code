import type { DashboardLocale } from "../../messages.js";

const messages = {
  es: {
    title: "Instalar Marea para el alumnado",
    instructions:
      "Copia el comando del sistema del alumno. Incluye la versión de este servidor y su dirección.",
    releases: "Versiones de prueba",
  },
  en: {
    title: "Install Marea for students",
    instructions:
      "Copy the command for the student's system. It includes this server's version and address.",
    releases: "Preview versions",
  },
  eu: {
    title: "Instalatu Marea ikasleentzat",
    instructions:
      "Kopiatu ikaslearen sistemarako komandoa. Zerbitzari honen bertsioa eta helbidea ditu.",
    releases: "Probako bertsioak",
  },
};

export function previewInstallCommands(repository: string, version: string, origin: string) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\d+\.\d+\.\d+-preview\.\d+$/u.test(version)
  )
    return null;
  const url = new URL(origin);
  if (!/^[A-Za-z0-9.:[\]-]+$/u.test(url.hostname)) return null;
  if (!(
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ))
    return null;
  const address = url.origin;
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return {
    posix: `curl -fsSL '${base}/install.sh' | sh -s -- student --server '${address}'`,
    windows: `& ([scriptblock]::Create((Invoke-RestMethod '${base}/install.ps1'))) -Component student -Server '${address}'`,
    releases: `https://github.com/${repository}/releases`,
  };
}

/** Present only in native preview builds, whose immutable metadata is compiled into the dashboard. */
export function PreviewInstall({ locale }: { locale: DashboardLocale }) {
  const repository = import.meta.env.VITE_MAREA_PREVIEW_REPOSITORY;
  const version = import.meta.env.VITE_MAREA_PREVIEW_VERSION;
  if (!repository || !version) return null;
  const commands = previewInstallCommands(repository, version, window.location.origin);
  if (commands === null) return null;
  const m = messages[locale];
  return (
    <aside className="preview-install">
      <h3>{m.title}</h3>
      <p>{m.instructions}</p>
      <p>
        Marea {version} ·{" "}
        <a href={commands.releases} target="_blank" rel="noreferrer">
          {m.releases}
        </a>
      </p>
      <label>
        macOS / Linux
        <textarea readOnly rows={3} value={commands.posix} />
      </label>
      <label>
        Windows PowerShell
        <textarea readOnly rows={3} value={commands.windows} />
      </label>
    </aside>
  );
}
