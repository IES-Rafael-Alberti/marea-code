import type { ProviderSettingsDescriptor } from "./provider-settings.js";
import type { ProviderModel } from "./provider-models.js";
import * as z from "zod";

import {
  createCommonManifestShape,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";

export function createInferenceProviderManifestSchema() {
  return z
    .object({
      ...createCommonManifestShape(),
      kind: z.literal("inference-provider"),
      apiVersion: z.literal("1.0"),
      capabilities: z
        .array(
          z.enum([
            "image-input",
            "prompt-caching",
            "reasoning-controls",
            "streaming",
            "structured-output",
            "tool-calls",
          ]),
        )
        .refine((values) => new Set(values).size === values.length, "Capabilities must be unique.")
        .readonly(),
      runtimeTargets: z.tuple([z.literal("teacher-server")]).readonly(),
      dataClassifications: z
        .array(z.enum(["student-content", "student-identifier", "usage-metadata"]))
        .min(1)
        .refine(
          (values) => new Set(values).size === values.length,
          "Data classifications must be unique.",
        )
        .readonly(),
    })
    .strict()
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .readonly();
}

export type InferenceProviderManifest = z.infer<
  ReturnType<typeof createInferenceProviderManifestSchema>
>;

export interface InferenceProviderCatalogEntry {
  readonly settings?: ProviderSettingsDescriptor;
  readonly manifest: InferenceProviderManifest;
  readonly create: InferenceProviderFactory;
  readonly listModels?: (
    configuration: InferenceProviderConfiguration,
    signal: AbortSignal,
  ) => Promise<readonly ProviderModel[]>;
}

export type InferenceMessageRole = "assistant" | "system" | "tool" | "user";

export interface InferenceMessageToolCall {
  readonly arguments: Readonly<Record<string, string>>;
  readonly callId: string;
  readonly name: string;
}

export interface InferenceMessage {
  readonly content: string;
  readonly role: InferenceMessageRole;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly InferenceMessageToolCall[];
}

export type InferenceJsonValue = z.infer<ReturnType<typeof z.json>>;

export interface InferenceToolDefinition {
  readonly description: string;
  readonly inputSchema: InferenceJsonValue;
  readonly name: string;
}

export interface InferenceProviderRequest {
  readonly maxOutputTokens?: number;
  readonly messages: readonly InferenceMessage[];
  readonly requestId: string;
  readonly tools: readonly InferenceToolDefinition[];
  readonly upstreamModel: string;
}

export type InferenceFinishReason = "length" | "stop" | "tool-call";

export type InferenceProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly arguments: Readonly<Record<string, string>>;
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "completed"; readonly finishReason: InferenceFinishReason };

export interface InferenceProvider {
  stream(
    request: InferenceProviderRequest,
    cancellation: InferenceCancellation,
  ): AsyncIterable<InferenceProviderEvent>;
}

export interface InferenceCancellation {
  readonly aborted: boolean;
  subscribe(listener: () => void): () => void;
}

export interface InferenceProviderConfiguration {
  readonly settings?: Readonly<Record<string, string>>;
  readonly apiKey: string;
  readonly endpoint?: string;
}

export type InferenceProviderFactory = (
  configuration: InferenceProviderConfiguration,
) => InferenceProvider;

export type InferenceProviderErrorCode =
  "aborted" | "authentication-failed" | "invalid-response" | "rate-limited" | "unavailable";

export class InferenceProviderError extends Error {
  public readonly code: InferenceProviderErrorCode;
  public readonly retryAfterMs: number | undefined;
  public readonly retryable: boolean;

  public constructor(options: {
    readonly code: InferenceProviderErrorCode;
    readonly message: string;
    readonly retryAfterMs?: number;
    readonly retryable: boolean;
  }) {
    super(options.message);
    this.name = "InferenceProviderError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function defineInferenceProviderCatalogEntry(
  entry: InferenceProviderCatalogEntry,
): InferenceProviderCatalogEntry {
  return entry;
}
