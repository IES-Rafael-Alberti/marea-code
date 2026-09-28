import type { ModelGatewayRequest, ModelGatewayStreamChunk } from "@marea/protocol";

import type { ModelGateway } from "../model-gateway/contracts.js";

const encoder = new TextEncoder();

export function modelStreamResponse(
  gateway: ModelGateway,
  request: ModelGatewayRequest,
  signal: AbortSignal,
): Response {
  const iterator = gateway.stream(request, signal)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async cancel(): Promise<void> {
      await iterator.return?.();
    },
    async pull(controller): Promise<void> {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
      } catch {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function collectModelChunks(
  stream: AsyncIterable<ModelGatewayStreamChunk>,
): Promise<readonly ModelGatewayStreamChunk[]> {
  return collect(stream);
}

async function collect(
  stream: AsyncIterable<ModelGatewayStreamChunk>,
): Promise<readonly ModelGatewayStreamChunk[]> {
  const chunks: ModelGatewayStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
