import * as z from "zod";

import { RequestIdSchema } from "./identifiers.js";
import { ProtocolVersionSchema } from "./version.js";

export const ProtocolErrorCodeSchema = z.enum([
  "auth.invalid",
  "protocol.incompatible",
  "request.invalid",
  "run.unavailable",
  "server.error",
]);

export const ProtocolErrorResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema.optional(),
    requestId: RequestIdSchema.optional(),
    error: z
      .object({
        code: ProtocolErrorCodeSchema,
        retryable: z.boolean(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ProtocolErrorResponse = z.infer<typeof ProtocolErrorResponseSchema>;
