import * as z from "zod";
import { ObservabilityConfigurationSchema } from "../observability/configuration.js";
import { PrivateProviderRouteSchema } from "../model-gateway/route-policy.js";
import { EducationalConfigurationSchema } from "../educational-insights/configuration.js";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { ServerSetupRequestSchema } from "@marea/protocol";

export const ServerSettingsSchema = z
  .object({
    version: z.literal(1),
    observability: ObservabilityConfigurationSchema.optional(),
    identityConnections: ServerSetupRequestSchema.shape.identityProviders,
    revision: z.number().int().nonnegative(),
    administrators: z.array(z.string().min(1).max(128)).min(1).max(100),
    connections: z.record(z.string().max(128), z.record(z.string().max(64), z.string().max(2048))),
    route: PrivateProviderRouteSchema.nullable(),
    education: EducationalConfigurationSchema,
    legacyRoutes: z
      .array(z.object({ classId: z.string(), route: PrivateProviderRouteSchema }).strict())
      .max(10000)
      .default([]),
    useCommonRoute: z.boolean(),
  })
  .strict();
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
export interface ServerSettingsStore {
  read(): ServerSettings | null;
  write(value: ServerSettings, expectedRevision: number): void;
}
export interface ServerSettingsEndpoint {
  execute(
    identity: AuthenticatedIdentity,
    input: Uint8Array,
    signal?: AbortSignal,
  ): object | Promise<object>;
}
export class ServerSettingsError extends Error {
  constructor(readonly status: number) {
    super("Server settings request failed");
  }
}
