import { defineIdentityProviderCatalogEntry } from "../../../../../../../packages/plugin-api/src/index.js";

const label = { es: "Sintético", en: "Synthetic", eu: "Sintetikoa" } as const;

export default defineIdentityProviderCatalogEntry({
  create() {
    throw new Error("The synthetic identity provider is never constructed.");
  },
  descriptor: { displayName: label, ruleKinds: [{ kind: "email", label }] },
  settings: { version: 1, name: label, fields: [] },
  manifest: {
    id: "org.marea.fixture-identity",
    displayNameKey: "plugins.fixture-identity.name",
    descriptionKey: "plugins.fixture-identity.description",
    kind: "identity-provider",
    apiVersion: "1.0",
    implementationVersion: "1.0.0",
    entrypoint: "./src/index.ts",
    configurationVersion: 1,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["authorization-code"],
    runtimeTargets: ["teacher-server"],
    dataClassifications: ["student-identifier"],
  },
});
