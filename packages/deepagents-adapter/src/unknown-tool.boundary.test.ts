import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { createUnknownToolMiddleware } from "./unknown-tool.boundary.js";

type Wrap = NonNullable<ReturnType<typeof createUnknownToolMiddleware>["wrapToolCall"]>;

function wrap(): Wrap {
  const middleware = createUnknownToolMiddleware(() => [
    "marea_execute",
    "marea_execute",
    "marea_list_project",
  ]);
  if (middleware.wrapToolCall === undefined) throw new Error("The middleware wraps tool calls.");
  return middleware.wrapToolCall;
}

describe("unknown tool middleware", () => {
  it("answers an unknown tool with an error result naming the offered tools once", async () => {
    const handler = vi.fn();
    const result = await wrap()(
      { toolCall: { id: "call-1", name: "marea_delete", args: {} } } as Parameters<Wrap>[0],
      handler,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(ToolMessage);
    expect(result).toMatchObject({
      tool_call_id: "call-1",
      name: "marea_delete",
      status: "error",
      content: "Error: delete is not an available tool. Use one of: execute, ls.",
    });
  });

  it("hands a known tool to the next handler", async () => {
    const handler = vi.fn(() => "handled");
    const request = { tool: {}, toolCall: { id: "call-2", name: "marea_list_project", args: {} } };
    expect(await wrap()(request as Parameters<Wrap>[0], handler as never)).toBe("handled");
    expect(handler).toHaveBeenCalledWith(request);
  });

  it("answers a DeepAgents built-in as unknown even though upstream registered it", async () => {
    const handler = vi.fn();
    const result = await wrap()(
      { tool: {}, toolCall: { id: "call-3", name: "ls", args: {} } } as Parameters<Wrap>[0],
      handler,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error", name: "ls" });
  });
});
