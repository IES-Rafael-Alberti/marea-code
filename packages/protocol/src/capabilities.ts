import * as z from "zod";

import { RequestIdSchema } from "./identifiers.js";
import { SoftwareVersionSchema } from "./technical.js";
import { ProtocolVersionSchema } from "./version.js";

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

function isServerCapability(value: string): boolean {
  return value.length <= 128 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
}

export const ServerCapabilitySchema = z
  .string()
  .refine(isServerCapability, "Use a portable namespaced capability.")
  .brand<"ServerCapability">();

const ProtocolVersionListSchema = z
  .array(ProtocolVersionSchema)
  .min(1)
  .max(8)
  .refine(uniqueStrings, "Protocol versions must be unique.")
  .readonly();

const ServerCapabilityListSchema = z
  .array(ServerCapabilitySchema)
  .max(128)
  .refine(uniqueStrings, "Server capabilities must be unique.")
  .readonly();

export const CapabilitiesRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    clientVersion: SoftwareVersionSchema,
    supportedProtocolVersions: ProtocolVersionListSchema,
  })
  .readonly();

export const CapabilitiesResponseSchema = z
  .object({
    requestId: RequestIdSchema,
    serverVersion: SoftwareVersionSchema,
    supportedProtocolVersions: ProtocolVersionListSchema,
    capabilities: ServerCapabilityListSchema,
  })
  .readonly();

export type CapabilitiesRequest = z.infer<typeof CapabilitiesRequestSchema>;
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
export type ServerCapability = z.infer<typeof ServerCapabilitySchema>;

export function missingCapabilities(
  available: readonly ServerCapability[],
  required: readonly ServerCapability[],
): readonly ServerCapability[] {
  const availableSet = new Set(available);
  return required.filter((capability) => !availableSet.has(capability));
}
