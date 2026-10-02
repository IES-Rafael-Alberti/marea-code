import { readOperatorCliConfig } from "../operator-cli/composition.js";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { OperatorDocumentSchema } from "../operator/operator-configuration-parser.js";
import { readFileSync } from "node:fs";
import { readTeacherHostConfig } from "./teacher-host-config.js";
import { serverSettingsStore } from "./server-settings-store.boundary.js";
import type { ServerSettings } from "../../server-settings/contracts.js";
import type { InstallationCapability } from "../../governance/authority.js";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { TeacherDomainError } from "../../identity/errors.js";
import { OperatorCliError } from "../operator-cli/errors.js";

/**
 * Validates and reads everything the explicit offline grant needs, without writing. Callers take
 * their safety backup only after this succeeds, so a refused grant leaves no orphaned bundle.
 */
export function prepareServerSettings(
  capability: InstallationCapability,
  database: SqliteApplicationDatabase,
  userId: string,
): ServerSettings {
  capability.assertOwned();
  const root = capability.installationRoot;
  if (serverSettingsStore(root).read() !== null) throw new TeacherDomainError("request.conflict");
  const account = database.readOne("SELECT role FROM marea_users WHERE id = ?1", [userId]);
  if (account?.role !== "teacher") throw new OperatorCliError("invalid-input");
  const host = readTeacherHostConfig(root);
  const operator = readOperatorCliConfig(root);
  const document = OperatorDocumentSchema.parse(
    JSON.parse(new TextDecoder().decode(readBoundedBytes(operator.operatorPolicyPath, 4_194_304))),
  );
  const legacyRoutes = document.classes.map((item) => ({
    classId: item.classId,
    route: item.policy.route.providerRoute,
  }));
  return {
    version: 1,
    revision: 0,
    administrators: [userId],
    connections: Object.fromEntries(
      host.providers.map((provider) => [
        provider.pluginId,
        {
          apiKey: readFileSync(provider.credentialPath, "utf8").trim(),
          ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
        },
      ]),
    ),
    route: legacyRoutes[0]?.route ?? null,
    legacyRoutes,
    education: host.educationalInsights ?? {},
    useCommonRoute: false,
  };
}

/** Explicit offline grant; original host configuration and credential files remain untouched. */
export function commitServerSettings(capability: InstallationCapability, value: ServerSettings) {
  capability.assertOwned();
  // The exclusive installation lock makes the absence checked during preparation still hold.
  serverSettingsStore(capability.installationRoot).write(value, -1);
  return { revision: value.revision };
}
