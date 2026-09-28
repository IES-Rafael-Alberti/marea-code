import {
  CURRENT_PROTOCOL_VERSION,
  ProtocolVersionSchema,
  ServerCapabilitySchema,
  missingCapabilities,
  selectProtocolVersion,
} from "@marea/protocol";

import type { IdSource, StudentServer } from "./contracts.js";

const CLIENT_PROTOCOL_VERSION = ProtocolVersionSchema.parse(CURRENT_PROTOCOL_VERSION);
const REQUIRED_CAPABILITIES = [
  "marea.auth.student",
  "marea.class.bootstrap",
  "marea.runs.events",
  "marea.runs.lifecycle",
  "marea.runs.exact-resume",
  "marea.runs.authenticated-close",
  "marea.runs.lease-renewal",
] as const;

export interface SessionCapabilityOptions {
  readonly clientVersion: string;
  readonly ids: IdSource;
  readonly server: StudentServer;
}

export async function negotiateSessionCapabilities(
  options: SessionCapabilityOptions,
): Promise<void> {
  const request = {
    requestId: options.ids.request(),
    clientVersion: options.clientVersion,
    supportedProtocolVersions: [CLIENT_PROTOCOL_VERSION],
  } as const;
  const response = await options.server.capabilities(request);
  if (response.requestId !== request.requestId) {
    throw new Error("The teacher server returned an unrelated capabilities response.");
  }
  if (
    selectProtocolVersion([CLIENT_PROTOCOL_VERSION], response.supportedProtocolVersions) === null
  ) {
    throw new Error("The teacher server does not support this Marea protocol version.");
  }
  const required = REQUIRED_CAPABILITIES.map((capability) =>
    ServerCapabilitySchema.parse(capability),
  );
  const missing = missingCapabilities(response.capabilities, required);
  if (missing.length === 0) return;
  throw new Error(`The teacher server is missing required capabilities: ${missing.join(", ")}.`);
}
