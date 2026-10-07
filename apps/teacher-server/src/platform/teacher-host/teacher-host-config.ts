import { EducationalConfigurationSchema } from "../../educational-insights/configuration.js";
import { telemetryRuntimeConfigurationSchema } from "../telemetry/runtime-configuration.boundary.js";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  MAX_GOVERNANCE_REQUEST_BYTES,
  RevisionIdSchema,
  SoftwareVersionSchema,
} from "@marea/protocol";
import { z } from "zod";
import { identityProviderCatalog, inferenceProviderCatalog } from "@marea/plugin-runtime";

import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { OperatorCliError } from "../operator-cli/errors.js";
import { currentUid, privateDescendantKind, privateKind } from "../operator-cli/private-path.js";

function hostSchema() {
  const positive = z.number().int().positive();
  return z
    .object({
      version: z.literal(1),
      educationalInsights: EducationalConfigurationSchema.exactOptional(),
      telemetry: telemetryRuntimeConfigurationSchema().exactOptional(),
      releaseId: RevisionIdSchema,
      listen: z
        .object({ hostname: z.string().min(1), port: z.number().int().min(0).max(65_535) })
        .strict(),
      allowedHosts: z.array(z.string().min(1)).min(1),
      allowedOrigins: z.array(z.string().min(1)).min(1),
      secureDashboardCookie: z.boolean(),
      serverVersion: SoftwareVersionSchema,
      statusPath: z.string(),
      digestKeyPath: z.string(),
      dashboardDistPath: z.string(),
      providers: z.array(
        z
          .object({
            pluginId: z.string().min(1),
            credentialPath: z.string(),
            endpoint: z.url().exactOptional(),
          })
          .strict(),
      ),
      /** Private settings files of installed identity provider plugins, such as OAuth clients. */
      identityProviders: z
        .array(z.object({ pluginId: z.string().min(1), settingsPath: z.string() }).strict())
        .max(8)
        .exactOptional(),
      retry: z.object({ delayMs: positive, maxDelayMs: positive }).strict(),
      evaluationIntervalMs: positive,
      shutdownDrainMs: positive,
    })
    .strict();
}
/** Private OPERATIONS teacher host contract `<root>/config/teacher-host.json`. */
export type TeacherHostConfig = z.infer<ReturnType<typeof hostSchema>>;

export function unavailable(): OperatorCliError {
  return new OperatorCliError("prerequisite-unavailable");
}

function absentOrFile(root: string, path: string, uid: number): boolean {
  try {
    return privateDescendantKind(root, path, uid) === "file";
  } catch {
    const parent = dirname(path);
    return parent === root || privateDescendantKind(root, parent, uid) === "directory";
  }
}

/**
 * Closed and explicit: the digest key and provider credentials are existing private files, the
 * status file absent or private, all inside the data installation. The dashboard may live in a
 * separate program installation, with a canonical private distribution root. Listening, origins,
 * retry, evaluation and drain values are never defaulted.
 */
export function readTeacherHostConfig(
  root: string,
  uid = currentUid(),
  installed = {
    identity: identityProviderCatalog.map((entry) => entry.manifest.id),
    inference: inferenceProviderCatalog.map((entry) => entry.manifest.id),
  },
): TeacherHostConfig {
  const configPath = join(root, "config", "teacher-host.json");
  if (privateDescendantKind(root, configPath, uid) !== "file") throw unavailable();
  const config = hostSchema().parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readBoundedBytes(configPath, MAX_GOVERNANCE_REQUEST_BYTES),
      ),
    ),
  );
  const identityProviders = config.identityProviders;
  // Retired plugins are inert: do not inspect or load their former credential files.
  const providers = config.providers.filter((entry) =>
    installed.inference.includes(entry.pluginId),
  );
  const activeIdentities =
    identityProviders?.filter((entry) => installed.identity.includes(entry.pluginId)) ?? [];
  const files = [
    config.digestKeyPath,
    ...providers.map((entry) => entry.credentialPath),
    ...activeIdentities.map((entry) => entry.settingsPath),
  ];
  if (
    files.some((path) => privateDescendantKind(root, path, uid) !== "file") ||
    realpathSync(config.dashboardDistPath) !== config.dashboardDistPath ||
    privateKind(config.dashboardDistPath, uid) !== "directory" ||
    !absentOrFile(root, config.statusPath, uid) ||
    new Set(config.providers.map((entry) => entry.pluginId)).size !== config.providers.length ||
    (identityProviders !== undefined &&
      new Set(identityProviders.map((entry) => entry.pluginId)).size !== identityProviders.length)
  )
    throw unavailable();
  return {
    ...config,
    providers,
    ...(config.identityProviders === undefined ? {} : { identityProviders: activeIdentities }),
  };
}
