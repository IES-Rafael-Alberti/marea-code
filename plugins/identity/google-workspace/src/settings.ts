import type { ProviderSettingsDescriptor } from "@marea/plugin-api";
import * as z from "zod";

const text = (es: string, en: string, eu: string) => ({ es, en, eu });

export const googleWorkspaceSettings: ProviderSettingsDescriptor = {
  version: 1,
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
      kind: "text",
      required: true,
      label: text("Dominio del centro", "School domain", "Ikastetxearen domeinua"),
    },
    {
      key: "serviceAccountEmail",
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
      required: false,
      label: text(
        "Clave privada de la cuenta de servicio (PEM)",
        "Service account private key (PEM)",
        "Zerbitzu-kontuaren gako pribatua (PEM)",
      ),
    },
    {
      key: "adminEmail",
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

const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);
const EmailSchema = z
  .string()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+$/u);

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
