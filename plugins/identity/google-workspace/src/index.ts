import {
  defineIdentityProviderCatalogEntry,
  type IdentityProviderCatalogEntry,
} from "@marea/plugin-api";

import { createGoogleWorkspaceProvider } from "./provider.js";
import { googleWorkspaceSettings } from "./settings.js";

const googleWorkspacePlugin: IdentityProviderCatalogEntry = defineIdentityProviderCatalogEntry({
  create: createGoogleWorkspaceProvider,
  descriptor: {
    displayName: {
      es: "Cuenta de Google del centro",
      en: "School Google account",
      eu: "Ikastetxeko Google kontua",
    },
    ruleKinds: [
      {
        kind: "email",
        label: { es: "Correos del alumnado", en: "Student addresses", eu: "Ikasleen helbideak" },
      },
      {
        kind: "group",
        label: { es: "Grupos de Google", en: "Google groups", eu: "Google taldeak" },
      },
    ],
  },
  settings: googleWorkspaceSettings,
  manifest: {
    apiVersion: "1.0",
    capabilities: ["authorization-code", "group-admission"],
    configurationVersion: 1,
    conflicts: [],
    dataClassifications: ["student-identifier"],
    descriptionKey: "plugins.google-workspace.description",
    displayNameKey: "plugins.google-workspace.name",
    entrypoint: "./src/index.ts",
    id: "org.marea.google-workspace",
    implementationVersion: "0.1.0",
    kind: "identity-provider",
    optionalDependencies: [],
    requiredDependencies: [],
    runtimeTargets: ["teacher-server"],
  },
});

export default googleWorkspacePlugin;
