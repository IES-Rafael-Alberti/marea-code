import { tool, type WhenPredicate } from "langchain";
import * as z from "zod";
import { AgentAdapterError, type ApprovalTool } from "./contracts.js";
import { observeExecution, type ToolLifecycleEvent } from "./tool-events.boundary.js";
import { QUESTION_TOOL_NAME } from "./questions.boundary.js";

export function createControlledTools(
  effects: readonly ApprovalTool[],
  report: (event: ToolLifecycleEvent) => void,
  blocked?: WhenPredicate,
) {
  const names = new Set([QUESTION_TOOL_NAME]);
  const tools = effects.map((effect) => {
    if (names.has(effect.name))
      throw new AgentAdapterError(
        "invalid-runtime-dependency",
        "Runtime tool names must be unique.",
      );
    names.add(effect.name);
    const execute = (input: Readonly<Record<string, string>>) =>
      effect.execute(Object.freeze({ ...input }));
    return tool(
      effect.lifecycle === "external" ? execute : observeExecution(effect.name, execute, report),
      {
        name: effect.name,
        description: effect.description,
        schema: z.record(z.string(), z.string()),
      },
    );
  });
  return {
    tools,
    interrupts: Object.fromEntries(
      effects.map((effect) => [
        effect.name,
        {
          allowedDecisions: ["approve", "edit", "reject"] as ("approve" | "edit" | "reject")[],
          ...(blocked === undefined
            ? {}
            : { when: async (request: Parameters<WhenPredicate>[0]) => !(await blocked(request)) }),
        },
      ]),
    ),
  };
}
