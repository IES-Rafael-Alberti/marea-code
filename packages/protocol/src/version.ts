import * as z from "zod";

export const CURRENT_PROTOCOL_VERSION = "0.1" as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [CURRENT_PROTOCOL_VERSION] as const;
const supportedProtocolVersions: ReadonlySet<string> = new Set(SUPPORTED_PROTOCOL_VERSIONS);

export const ProtocolVersionSchema = z
  .string()
  .regex(/^\d+\.\d+$/)
  .brand<"ProtocolVersion">();

export const CurrentProtocolVersionSchema = z.literal(CURRENT_PROTOCOL_VERSION);

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export function isSupportedProtocolVersion(version: string): boolean {
  return supportedProtocolVersions.has(version);
}

export function selectProtocolVersion(
  clientVersions: readonly ProtocolVersion[],
  serverVersions: readonly ProtocolVersion[],
): ProtocolVersion | null {
  const serverSet = new Set(serverVersions);
  return clientVersions.find((version) => serverSet.has(version)) ?? null;
}
