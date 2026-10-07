import type { DashboardLocale } from "../../messages.js";
import { useState } from "react";
import { studentAddressChoices, studentOrigin } from "./preview-addresses.js";

const messages = {
  es: {
    title: "Instalar Marea para el alumnado",
    instructions:
      "Copia el comando del sistema del alumno. La dirección debe ser accesible desde su equipo.",
    address: "Dirección del servidor para el alumnado",
    choose: "Elige la dirección de la red del aula",
    unavailable:
      "No hay una dirección para otros equipos. Para usar HTTP en el aula, arranca marea-teacher --allow-http y recarga el panel. Para HTTPS, configura la dirección pública del servidor.",
    releases: "Versiones de prueba",
  },
  en: {
    title: "Install Marea for students",
    instructions:
      "Copy the command for the student's system. The address must be reachable from their computer.",
    address: "Server address for students",
    choose: "Choose the classroom network address",
    unavailable:
      "No address is available for other computers. For classroom HTTP access, start marea-teacher --allow-http and reload the dashboard. For HTTPS, configure the server's public address.",
    releases: "Preview versions",
  },
  eu: {
    title: "Instalatu Marea ikasleentzat",
    instructions:
      "Kopiatu ikaslearen sistemarako komandoa. Helbideak ikaslearen ordenagailutik eskuragarri egon behar du.",
    address: "Zerbitzariaren helbidea ikasleentzat",
    choose: "Aukeratu ikasgelako sarearen helbidea",
    unavailable:
      "Ez dago beste ordenagailuentzako helbiderik. Ikasgelan HTTP erabiltzeko, abiarazi marea-teacher --allow-http eta birkargatu panela. HTTPS erabiltzeko, konfiguratu zerbitzariaren helbide publikoa.",
    releases: "Probako bertsioak",
  },
};

function previewBase(repository: string, version: string): string | null {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\d+\.\d+\.\d+-preview\.\d+$/u.test(version)
  )
    return null;
  return `https://github.com/${repository}/releases/download/v${version}`;
}

export function previewInstallCommands(repository: string, version: string, origin: string) {
  const base = previewBase(repository, version);
  const address = studentOrigin(origin);
  if (base === null || address === null) return null;
  return {
    posix: `curl -fsSL '${base}/install.sh' | sh -s -- student --server '${address}'`,
    windows: `& ([scriptblock]::Create((Invoke-RestMethod '${base}/install.ps1'))) -Component student -Server '${address}'`,
    releases: `https://github.com/${repository}/releases`,
  };
}

/** Present only in native preview builds, whose immutable metadata is compiled into the dashboard. */
export function PreviewInstall({
  locale,
  // Stryker disable next-line ArrayDeclaration: The injected invalid URL is filtered out just like an absent origin.
  origins = [],
}: {
  locale: DashboardLocale;
  origins?: readonly string[] | undefined;
}) {
  const repository = import.meta.env.VITE_MAREA_PREVIEW_REPOSITORY;
  const version = import.meta.env.VITE_MAREA_PREVIEW_VERSION;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: Narrows optional build metadata; previewBase also rejects absent or empty values.
  if (!repository || !version) return null;
  if (previewBase(repository, version) === null) return null;
  return (
    <InstallAddress
      locale={locale}
      repository={repository}
      version={version}
      {...studentAddressChoices(origins, window.location.origin)}
    />
  );
}

function InstallAddress({
  locale,
  repository,
  version,
  choices,
  initial,
}: {
  locale: DashboardLocale;
  repository: string;
  version: string;
  choices: readonly string[];
  initial: string;
}) {
  const [selected, select] = useState(initial);
  const address = choices.includes(selected) ? selected : initial;
  const commands = previewInstallCommands(repository, version, address);
  const m = messages[locale];
  return (
    <aside className="preview-install">
      <h3>{m.title}</h3>
      <p>{m.instructions}</p>
      {choices.length === 0 ? (
        <p role="status">{m.unavailable}</p>
      ) : (
        <label>
          {m.address}
          <select
            value={address}
            onChange={(event) => {
              select(event.currentTarget.value);
            }}
          >
            <option value="" disabled>
              {m.choose}
            </option>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
      )}
      {commands !== null && (
        <>
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
        </>
      )}
    </aside>
  );
}
