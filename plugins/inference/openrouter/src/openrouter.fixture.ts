import type {
  InferenceCancellation,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";

import type {
  OpenRouterHttpPort,
  OpenRouterHttpRequest,
  OpenRouterHttpResponse,
} from "./contracts.js";

const WRITE_FILE_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", description: "Virtual path." },
    content: { type: "string", description: "New content." },
  },
  required: ["path", "content"],
});

export const REQUEST: InferenceProviderRequest = Object.freeze({
  messages: Object.freeze([
    Object.freeze({ content: "Be concise.", role: "system" }),
    Object.freeze({ content: "Ready.", role: "assistant" }),
    Object.freeze({ content: "Update the file.", role: "user" }),
    Object.freeze({
      content: "",
      role: "assistant",
      toolCalls: Object.freeze([
        Object.freeze({
          arguments: Object.freeze({ path: "a.txt", content: "New text." }),
          callId: "call-1",
          name: "write_file",
        }),
      ]),
    }),
    Object.freeze({ content: "Done.", role: "tool", toolCallId: "call-1" }),
  ]),
  requestId: "request-1",
  tools: Object.freeze([
    Object.freeze({
      description: "Replace a text file.",
      name: "write_file",
      inputSchema: WRITE_FILE_PARAMETERS,
    }),
  ]),
  upstreamModel: "private-model",
});

export const EXPECTED_OPENROUTER_BODY = Object.freeze({
  messages: [
    { content: "Be concise.", role: "system" },
    { content: "Ready.", role: "assistant" },
    { content: "Update the file.", role: "user" },
    {
      content: null,
      role: "assistant",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "write_file",
            arguments: '{"path":"a.txt","content":"New text."}',
          },
        },
      ],
    },
    { content: "Done.", role: "tool", tool_call_id: "call-1" },
  ],
  model: "private-model",
  stream: true,
  stream_options: { include_usage: true },
  tool_choice: "auto",
  tools: [
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Replace a text file.",
        parameters: WRITE_FILE_PARAMETERS,
      },
    },
  ],
});

interface PartialToolCall {
  readonly arguments?: string;
  readonly id?: string;
  readonly name?: string;
}

export function toolCallChunk(toolCall: PartialToolCall): string {
  const { id, ...functionCall } = toolCall;
  return JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(id === undefined ? {} : { id }),
              function: functionCall,
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

export class TestCancellation implements InferenceCancellation {
  #listener: (() => void) | undefined;
  public aborted = false;
  public unsubscribed = false;

  public abort(): void {
    this.aborted = true;
    this.#listener?.();
  }

  public subscribe(listener: () => void): () => void {
    this.#listener = listener;
    return () => {
      this.unsubscribed = true;
      this.#listener = undefined;
    };
  }
}

export class TestHttp implements OpenRouterHttpPort {
  public readonly requests: OpenRouterHttpRequest[] = [];
  public response: OpenRouterHttpResponse;

  public constructor(response: OpenRouterHttpResponse) {
    this.response = response;
  }

  public send(request: OpenRouterHttpRequest): Promise<OpenRouterHttpResponse> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

export function httpResponse(
  content: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly status?: number;
  } = {},
): OpenRouterHttpResponse {
  const response = new Response(content, options);
  return response;
}

export function sse(...values: readonly string[]): string {
  return `${values.map((value) => `data: ${value}\n\n`).join("")}data: [DONE]\n\n`;
}

export async function collect(
  stream: AsyncIterable<InferenceProviderEvent>,
): Promise<readonly InferenceProviderEvent[]> {
  const events: InferenceProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
