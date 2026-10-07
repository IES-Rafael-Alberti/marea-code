import * as z from "zod";

import { CredentialLoginSchema, CredentialPasswordSchema } from "./auth.js";
import { SafeDisplayNameSchema } from "./technical.js";
import { IdentityProviderIdSchema } from "./external-identity.js";
import { PrivateProviderRouteSchema } from "./server-model-route.js";

/** Local first-run setup only. This is not an extension of the student wire protocol. */
export const ServerSetupRequestSchema = z
  .object({
    center: SafeDisplayNameSchema,
    classroom: SafeDisplayNameSchema,
    teacher: SafeDisplayNameSchema,
    login: CredentialLoginSchema,
    password: CredentialPasswordSchema,
    port: z.number().int().min(1024).max(65535),
    access: z.enum(["local", "lan", "https"]),
    publicOrigin: z.string().max(2048),
    identityProviders: z
      .record(IdentityProviderIdSchema, z.record(z.string().max(64), z.string().max(16_384)))
      .refine((value) => Object.keys(value).length <= 8)
      .optional(),
    connections: z.record(z.string().max(128), z.record(z.string().max(64), z.string().max(2048))),
    route: PrivateProviderRouteSchema.refine((route) => route.budget !== undefined),
    testingSkill: z.boolean(),
  })
  .strict();

export type ServerSetupRequest = z.infer<typeof ServerSetupRequestSchema>;
