import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import * as z from "zod";

import { DEEPAGENTS_BUILT_IN_TOOLS, toPublicToolName } from "./tool-names.js";

/**
 * A call to a tool that does not exist is answered as a tool error listing the tools the model
 * was actually offered, by the names it sees, so it can correct itself. No alias is guessed.
 */
export function createUnknownToolMiddleware(offered: () => readonly string[]) {
  return createMiddleware({
    name: "MareaUnknownTool",
    wrapToolCall: (request, handler) => {
      const name = request.toolCall.name;
      if (request.tool !== undefined && !DEEPAGENTS_BUILT_IN_TOOLS.has(name))
        return handler(request);
      const available = [...new Set(offered().map(toPublicToolName))].join(", ");
      return new ToolMessage({
        // LangGraph assigns an ID before entering tool middleware.
        tool_call_id: z.string().parse(request.toolCall.id),
        name,
        status: "error",
        content: `Error: ${toPublicToolName(name)} is not an available tool. Use one of: ${available}.`,
      });
    },
  });
}
