import type { MareaModelGateway } from "@marea/deepagents-adapter";
import type { ModelGatewayStreamChunk } from "@marea/protocol";
import type { LocalSession } from "./local-session.js";
import type { IdSource } from "./contracts.js";

/** The recorded text of one chunk: model text, a tool call (with any repair) or a failure code. */
function chunkText(chunk: ModelGatewayStreamChunk): string {
  if (chunk.event === "text-delta") return chunk.delta;
  if (chunk.event === "tool-call")
    return `\n${JSON.stringify({
      tool: chunk.tool,
      arguments: chunk.arguments,
      ...(chunk.repair === undefined ? {} : { repair: chunk.repair }),
    })}\n`;
  return chunk.event === "failed" ? `\n${chunk.code}\n` : "";
}

export interface DiagnosticGateway extends MareaModelGateway {
  /** The last exchange's request and recorded response, for a failed turn's diagnostic. */
  readonly lastResponse: () => { readonly requestId: string; readonly content: string } | null;
}

/**
 * Captures normalized exchanges, never HTTP headers, credentials or provider envelopes. With a
 * server that stores turn diagnostics it also asks for, and records, how the provider's tool calls
 * were repaired.
 */
export function diagnosticGateway(
  gateway: MareaModelGateway,
  localSession: LocalSession,
  ids: IdSource,
  /** Set once the server announced that it stores turn diagnostics. */
  repairDetail: { readonly supported: boolean } = { supported: false },
): DiagnosticGateway {
  let last: { readonly requestId: string; readonly content: string } | null = null;
  return {
    lastResponse: () => last,
    async *stream(request, signal) {
      const record = async (
        phase: "request" | "response",
        content: string,
        status: "started" | "completed" | "failed" | "interrupted",
        truncated: boolean,
      ) => {
        await localSession.appendEvent(
          `model:${request.requestId}:${phase}`,
          (sequence, occurredAt) => ({
            eventType: "model-diagnostic",
            eventId: ids.event(),
            sequence,
            occurredAt,
            requestId: request.requestId,
            phase,
            status,
            content,
            truncated,
          }),
        );
      };
      const requestContent = JSON.stringify(
        { messages: request.messages, tools: request.tools.map((tool) => tool.name) },
        null,
        2,
      );
      await record(
        "request",
        requestContent.slice(0, 16_384),
        "started",
        requestContent.length > 16_384,
      );
      let text = "";
      let truncated = false;
      let status: "completed" | "failed" | "interrupted" = "interrupted";
      try {
        const sent = repairDetail.supported ? { ...request, diagnostics: true as const } : request;
        for await (const chunk of gateway.stream(sent, signal)) {
          const addition = chunkText(chunk);
          truncated ||= text.length + addition.length > 16_384;
          text = (text + addition).slice(0, 16_384);
          if (chunk.event === "completed") status = "completed";
          if (chunk.event === "failed") status = "failed";
          yield chunk;
        }
      } catch (error) {
        status = signal.aborted ? "interrupted" : "failed";
        throw error;
      } finally {
        last = { requestId: request.requestId, content: text };
        await record("response", text, status, truncated);
      }
    },
  };
}
