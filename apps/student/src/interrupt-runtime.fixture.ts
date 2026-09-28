import {
  createLocalCheckpoint,
  createMareaGatewayModel,
  type MareaModelGateway,
} from "@marea/deepagents-adapter";
import {
  ModelGatewayStreamChunkSchema,
  RequestIdSchema,
  type ModelGatewayRequest,
} from "@marea/protocol";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function interruptFixture(
  directory: string,
  tool: string,
  args: Record<string, string>,
  answer: string,
) {
  const requests: ModelGatewayRequest[] = [];
  const gateway: MareaModelGateway = {
    async *stream(request) {
      await Promise.resolve();
      requests.push(request);
      const base = {
        protocolVersion: "0.1",
        requestId: request.requestId,
        modelAlias: "marea",
        emittedAt: "2026-09-18T10:00:00.000Z",
      };
      yield ModelGatewayStreamChunkSchema.parse({ ...base, sequence: 0, event: "started" });
      yield ModelGatewayStreamChunkSchema.parse(
        requests.length === 1
          ? {
              ...base,
              sequence: 1,
              event: "tool-call",
              callId: "interrupt-one",
              tool,
              arguments: args,
            }
          : { ...base, sequence: 1, event: "text-delta", delta: answer },
      );
      yield ModelGatewayStreamChunkSchema.parse({
        ...base,
        sequence: 2,
        event: "completed",
        finishReason: requests.length === 1 ? "tool-call" : "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
  await mkdir(join(directory, "project"));
  const open = () =>
    createLocalCheckpoint({
      storageDirectory: join(directory, "state"),
      projectDirectory: join(directory, "project"),
    });
  const model = createMareaGatewayModel({
    gateway,
    nextRequestId: () => RequestIdSchema.parse(`request:${String(requests.length)}`),
  });
  return { requests, open, model };
}
