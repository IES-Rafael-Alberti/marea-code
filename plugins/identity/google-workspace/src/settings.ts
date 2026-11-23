import { googleSetupGuides } from "./setup-guides.js";
import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
import * as z from "zod";

const text = (es: string, en: string, eu: string) => ({ es, en, eu });

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const emailPattern = /^[^\s@]+@[^\s@]+$/u;
const domainLength = 253;
const emailLength = 320;
const emailValidation = {
  maxLength: emailLength,
  pattern: emailPattern.source,
  normalize: "none" as const,
  message: text(
    "Introduce una dirección de correo válida de hasta 320 caracteres.",
    "Enter a valid email address of up to 320 characters.",
    "Sartu gehienez 320 karaktereko baliozko helbide elektroniko bat.",
  ),
};
const DomainSchema = z.string().trim().toLowerCase().max(domainLength).regex(domainPattern);
const EmailSchema = z.string().max(emailLength).regex(emailPattern);

export const googleWorkspaceSettings: ProviderSettingsDescriptor = {
  version: 1,
  guides: googleSetupGuides,
  name: text(
    "Google Workspace del centro",
    "School Google Workspace",
    "Ikastetxeko Google Workspace",
  ),
  fields: [
    {
      key: "clientId",
      kind: "text",
      required: true,
      label: text("ID de cliente OAuth", "OAuth client ID", "OAuth bezero IDa"),
    },
    {
      key: "clientSecret",
      kind: "secret",
      required: true,
      label: text("Secreto del cliente OAuth", "OAuth client secret", "OAuth bezeroaren sekretua"),
    },
    {
      key: "domain",
      validation: {
        maxLength: domainLength,
        pattern: domainPattern.source,
        normalize: "lowercase-trim",
        message: text(
          "Introduce un dominio válido de hasta 253 caracteres, como centro.edu.",
          "Enter a valid domain of up to 253 characters, such as school.edu.",
          "Sartu gehienez 253 karaktereko baliozko domeinu bat, adibidez eskola.eus.",
        ),
      },
      kind: "text",
      required: true,
      label: text("Dominio del centro", "School domain", "Ikastetxearen domeinua"),
    },
    {
      key: "serviceAccountEmail",
      validation: emailValidation,
      kind: "text",
      required: false,
      label: text(
        "Cuenta de servicio para grupos",
        "Service account for groups",
        "Taldeetarako zerbitzu-kontua",
      ),
    },
    {
      key: "serviceAccountKey",
      kind: "secret",
      multiline: true,
      required: false,
      label: text(
        "Clave privada de la cuenta de servicio (PEM)",
        "Service account private key (PEM)",
        "Zerbitzu-kontuaren gako pribatua (PEM)",
      ),
    },
    {
      key: "adminEmail",
      validation: emailValidation,
      kind: "text",
      required: false,
      label: text(
        "Administrador al que actúa en nombre la cuenta de servicio",
        "Administrator the service account acts for",
        "Zerbitzu-kontuak ordezkatzen duen administratzailea",
      ),
    },
  ],
};

const GroupSettingsSchema = z
  .object({
    serviceAccountEmail: EmailSchema,
    serviceAccountKey: z.string().includes("-----BEGIN PRIVATE KEY-----"),
    adminEmail: EmailSchema,
  })
  .strict()
  .readonly();

export type GroupSettings = z.infer<typeof GroupSettingsSchema>;

export interface GoogleWorkspaceSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly domain: string;
  /** Group admission needs a service account with domain-wide delegation; absent, only addresses admit. */
  readonly groups: GroupSettings | undefined;
}

export function parseGoogleWorkspaceSettings(
  values: Readonly<Record<string, string>>,
): GoogleWorkspaceSettings {
  const { clientId, clientSecret, domain, ...groups } = values;
  return {
    clientId: z.string().min(1).parse(clientId),
    clientSecret: z.string().min(1).parse(clientSecret),
    domain: DomainSchema.parse(domain),
    groups: Object.keys(groups).length === 0 ? undefined : GroupSettingsSchema.parse(groups),
  };
}
