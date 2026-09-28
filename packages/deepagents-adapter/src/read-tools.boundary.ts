import { tool } from "langchain";
import * as z from "zod";

import { AgentAdapterError, ReadOnlyToolInputError, type ReadOnlyTool } from "./contracts.js";
import { observeExecution, type ToolLifecycleEvent } from "./tool-events.boundary.js";

const ToolNameSchema = z.enum([
  "marea_read_project",
  "marea_list_project",
  "marea_read_skill",
  "marea_search_project",
  "marea_glob_project",
]);

/** Built-in filesystem access stays denied; only host-supplied readers are admitted. */
export function createReadOnlyTools(
  tools: readonly ReadOnlyTool[],
  approvalName: string,
  report: (event: ToolLifecycleEvent) => void,
) {
  const names = new Set<string>([approvalName]);
  return tools.map((reader) => {
    const name = ToolNameSchema.parse(reader.name);
    if (names.has(name)) {
      throw new AgentAdapterError(
        "invalid-runtime-dependency",
        "Runtime tool names must be unique.",
      );
    }
    names.add(name);
    const observed = observeExecution(
      name,
      (input) => reader.execute(Object.freeze({ ...input })),
      report,
    );
    return tool(
      async (input) => {
        try {
          return await observed(input);
        } catch (error) {
          if (error instanceof ReadOnlyToolInputError) return `Error: ${error.message}`;
          throw error;
        }
      },
      {
        name,
        description: reader.description,
        schema: z.record(z.string(), z.string()),
      },
    );
  });
}
