import * as z from "zod";

import { RequestIdSchema, ToolCallIdSchema } from "./identifiers.js";
import { ModelAliasSchema, UtcTimestampSchema } from "./runs.js";
import { ToolNameSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const MessageContentSchema = z.string().min(1).max(65_536);

const TextModelMessageSchema = z
  .object({
    role: z.enum(["system", "student"]),
    content: MessageContentSchema,
  })
  .strict()
  .readonly();

const ModelMessageToolCallSchema = z
  .object({
    callId: ToolCallIdSchema,
    tool: ToolNameSchema,
    arguments: z.record(z.string(), z.string()),
  })
  .strict()
  .readonly();

const AssistantModelMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().max(65_536),
    toolCalls: z
      .array(ModelMessageToolCallSchema)
      .max(64)
      .refine(
        (calls) => new Set(calls.map((call) => call.callId)).size === calls.length,
        "Assistant tool call identifiers must be unique.",
      )
      .readonly(),
  })
  .strict()
  .refine(
    (message) => message.content.length > 0 || message.toolCalls.length > 0,
    "An assistant message must contain text or a tool call.",
  )
  .readonly();

const ToolModelMessageSchema = z
  .object({
    role: z.literal("tool"),
    callId: ToolCallIdSchema,
    tool: ToolNameSchema,
    content: MessageContentSchema,
  })
  .strict()
  .readonly();

export const ModelGatewayMessageSchema = z.discriminatedUnion("role", [
  TextModelMessageSchema,
  AssistantModelMessageSchema,
  ToolModelMessageSchema,
]);

const ModelToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().min(1).max(2_048),
    inputSchema: z.json(),
  })
  .strict()
  .readonly();

export const ModelGatewayRequestSchema = z
  .object({
    kind: z.literal("model-gateway-request"),
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    modelAlias: ModelAliasSchema,
    messages: z.array(ModelGatewayMessageSchema).min(1).max(256).readonly(),
    tools: z
      .array(ModelToolDefinitionSchema)
      .max(64)
      .refine(
        (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
        "Model tool names must be unique.",
      )
      .readonly(),
  })
  .strict()
  .readonly();

const chunkBaseShape = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  modelAlias: ModelAliasSchema,
  sequence: z.number().int().nonnegative(),
  emittedAt: UtcTimestampSchema,
};

const ModelStreamStartedSchema = z
  .object({ ...chunkBaseShape, event: z.literal("started") })
  .strict()
  .readonly();

const ModelStreamTextDeltaSchema = z
  .object({
    ...chunkBaseShape,
    event: z.literal("text-delta"),
    delta: z.string().min(1).max(16_384),
  })
  .strict()
  .readonly();

const ModelStreamToolCallSchema = z
  .object({
    ...chunkBaseShape,
    event: z.literal("tool-call"),
    callId: ToolCallIdSchema,
    tool: ToolNameSchema,
    arguments: z.record(z.string(), z.string()),
  })
  .strict()
  .readonly();

const ModelStreamCompletedSchema = z
  .object({
    ...chunkBaseShape,
    event: z.literal("completed"),
    finishReason: z.enum(["stop", "tool-call", "length"]),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

const ModelStreamFailedSchema = z
  .object({
    ...chunkBaseShape,
    event: z.literal("failed"),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    message: z.string().min(1).max(1_024),
    retryable: z.boolean(),
  })
  .strict()
  .readonly();

export const ModelGatewayStreamChunkSchema = z.discriminatedUnion("event", [
  ModelStreamStartedSchema,
  ModelStreamTextDeltaSchema,
  ModelStreamToolCallSchema,
  ModelStreamCompletedSchema,
  ModelStreamFailedSchema,
]);

export type ModelGatewayMessage = z.infer<typeof ModelGatewayMessageSchema>;
export type ModelGatewayRequest = z.infer<typeof ModelGatewayRequestSchema>;
export type ModelGatewayStreamChunk = z.infer<typeof ModelGatewayStreamChunkSchema>;
