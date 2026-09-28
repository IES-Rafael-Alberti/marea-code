import * as z from "zod";

import { InferenceProviderError } from "@marea/plugin-api";

import type { OpenRouterChunk, OpenRouterHttpPort, OpenRouterHttpResponse } from "./contracts.js";

const toolCallSchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: z.string().min(1).max(256).optional(),
    function: z
      .object({
        name: z.string().min(1).max(128).optional(),
        arguments: z.string().max(1_048_576).optional(),
      })
      .optional(),
  })
  .transform((call) => ({
    arguments: call.function?.arguments,
    id: call.id,
    index: call.index,
    name: call.function?.name,
  }));

const chunkSchema = z
  .object({
    choices: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          delta: z
            .object({
              content: z.string().nullable().optional(),
              tool_calls: z.array(toolCallSchema).max(64).optional(),
            })
            .optional(),
          finish_reason: z.string().max(64).nullable().optional(),
        }),
      )
      .max(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
  })
  .transform((chunk): OpenRouterChunk => {
    const choice = chunk.choices[0];
    const delta = choice?.delta;
    return {
      delta:
        delta === undefined
          ? undefined
          : {
              content: delta.content,
              toolCalls: delta.tool_calls,
            },
      finishReason: choice?.finish_reason,
      usage:
        chunk.usage == null
          ? undefined
          : {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            },
    };
  });

interface OpenRouterMessageBody {
  readonly content: string | null;
  readonly role: string;
  readonly tool_call_id?: string | undefined;
  readonly tool_calls?: readonly OpenRouterMessageToolCallBody[] | undefined;
}

interface OpenRouterMessageToolCallBody {
  readonly function: {
    readonly arguments: string;
    readonly name: string;
  };
  readonly id: string;
  readonly type: "function";
}

function createRequestBody(request: Parameters<OpenRouterHttpPort["send"]>[0]): string {
  const messages: readonly OpenRouterMessageBody[] = request.body.messages.map((message) => ({
    content: message.role === "assistant" && message.content.length === 0 ? null : message.content,
    role: message.role,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }));
  const tools = request.body.tools.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
  return JSON.stringify({
    max_tokens: z.number().int().positive().optional().parse(request.body.maxOutputTokens),
    messages,
    model: request.body.upstreamModel,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tool_choice: "auto", tools }),
  });
}

export const openRouterHttp: OpenRouterHttpPort = Object.freeze({
  async send(request: Parameters<OpenRouterHttpPort["send"]>[0]): Promise<OpenRouterHttpResponse> {
    const response = await fetch(request.endpoint, {
      body: createRequestBody(request),
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${request.apiKey}`,
        // Bun transparently re-sends a POST whose reused connection closes mid-response and
        // splices both bodies; a fresh connection surfaces the loss instead of a paid replay.
        Connection: "close",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: request.signal,
    });
    return response;
  },
});

export function parseOpenRouterChunk(input: unknown): OpenRouterChunk {
  return chunkSchema.parse(input);
}

export function parseOpenRouterData(text: string): OpenRouterChunk {
  try {
    return parseOpenRouterChunk(JSON.parse(text) as unknown);
  } catch {
    throw new InferenceProviderError({
      code: "invalid-response",
      message: "The inference provider returned an invalid stream chunk.",
      retryable: false,
    });
  }
}
