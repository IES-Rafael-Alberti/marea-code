import type { MareaModelGateway } from "@marea/deepagents-adapter";
import type { LocalSession } from "./local-session.js";
import type { IdSource } from "./contracts.js";

/** Captures normalized exchanges, never HTTP headers, credentials or provider envelopes. */
export function diagnosticGateway(
  gateway: MareaModelGateway,
  localSession: LocalSession,
  ids: IdSource,
): MareaModelGateway {
  return {
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
        for await (const chunk of gateway.stream(request, signal)) {
          const addition =
            chunk.event === "text-delta"
              ? chunk.delta
              : chunk.event === "tool-call"
                ? `\n${JSON.stringify({ tool: chunk.tool, arguments: chunk.arguments })}\n`
                : chunk.event === "failed"
                  ? `\n${chunk.code}\n`
                  : "";
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
        await record("response", text, status, truncated);
      }
    },
  };
}
