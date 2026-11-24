import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import * as z from "zod";

import { toPublicToolName } from "./tool-names.js";

/**
 * A call to a tool that does not exist is answered as a tool error listing the tools the model
 * was actually offered, by the names it sees, so it can correct itself. No alias is guessed.
 */
export function createUnknownToolMiddleware(offered: () => readonly string[]) {
  return createMiddleware({
    name: "MareaUnknownTool",
    wrapToolCall: (request, handler) => {
      if (request.tool !== undefined) return handler(request);
      const available = [...new Set(offered().map(toPublicToolName))].join(", ");
      return new ToolMessage({
        // LangGraph assigns an ID before entering tool middleware.
        tool_call_id: z.string().parse(request.toolCall.id),
        name: request.toolCall.name,
        status: "error",
        content: `Error: ${toPublicToolName(request.toolCall.name)} is not an available tool. Use one of: ${available}.`,
      });
    },
  });
}
