import type { ComponentPropsWithRef, ReactNode } from "react";
import type { DashboardLocale } from "../messages.js";

const copy = {
  es: { show: "Mostrar u ocultar", saved: "Clave guardada · Cambiar" },
  en: { show: "Show or hide", saved: "Key saved · Change" },
  eu: { show: "Erakutsi edo ezkutatu", saved: "Gakoa gordeta · Aldatu" },
};
interface SecretProps {
  label: string;
  locale: DashboardLocale;
  saved?: boolean;
}

export function SecretInput({
  label,
  locale,
  saved,
  ...input
}: Omit<ComponentPropsWithRef<"input">, "type"> & SecretProps) {
  return (
    <SecretControl label={label} locale={locale} saved={saved}>
      <input {...input} type="password" aria-label={label} />
    </SecretControl>
  );
}

/** Multiline private keys keep line breaks when pasted. */
export function SecretTextarea({
  label,
  locale,
  saved,
  ...input
}: ComponentPropsWithRef<"textarea"> & SecretProps) {
  return (
    <SecretControl label={label} locale={locale} saved={saved}>
      <textarea {...input} aria-label={label} className="secret-textarea" />
    </SecretControl>
  );
}

/** Visibility is local to the control. Stored secrets are never loaded into it. */
function SecretControl({
  label,
  locale,
  saved = false,
  children,
}: Omit<SecretProps, "saved"> & { saved: boolean | undefined; children: ReactNode }) {
  const field = (
    <span className="secret-control">
      {children}
      <button
        type="button"
        aria-label={`${copy[locale].show}: ${label}`}
        aria-pressed="false"
        onClick={(event) => {
          const button = event.currentTarget;
          const control = button.parentElement?.querySelector("input, textarea");
          if (!control) return;
          const visible = button.getAttribute("aria-pressed") !== "true";
          if (control instanceof HTMLInputElement) control.type = visible ? "text" : "password";
          else
            (control as HTMLTextAreaElement).style.setProperty(
              "-webkit-text-security",
              visible ? "none" : "disc",
            );
          button.setAttribute("aria-pressed", String(visible));
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </span>
  );
  return saved ? (
    <details className="saved-secret">
      <summary>{copy[locale].saved}</summary>
      {field}
    </details>
  ) : (
    field
  );
}
