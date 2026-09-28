import * as deepagents from "deepagents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MareaFakeModel, unusedTool } from "./adapter.fixture.js";
import { createInMemoryCheckpointForTest } from "./checkpoint.boundary.js";
import { bindTestModel, createAgentRuntime } from "./upstream.boundary.js";

vi.mock("deepagents", { spy: true });

afterEach(() => vi.clearAllMocks());

describe("upstream tool configuration boundary", () => {
  it.each([true, false])("configures independent read-only defenses for mode %s", (readOnly) => {
    const create = vi.mocked(deepagents.createDeepAgent);
    createAgentRuntime({
      model: bindTestModel(new MareaFakeModel()),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: unusedTool,
      systemPrompt: "Marea tutor.",
      readOnly,
      readOnlyTools: [
        {
          name: "marea_read_project",
          description: "Read project files.",
          execute: unusedTool.execute.bind(unusedTool),
        },
      ],
    });

    expect(create).toHaveBeenCalledTimes(1);
    const configuration = create.mock.calls[0]?.[0];
    expect(configuration?.tools?.map((candidate) => candidate.name)).toEqual(
      readOnly ? ["marea_read_project"] : [unusedTool.name, "marea_read_project"],
    );
    expect(configuration?.middleware?.map((middleware) => middleware.name)).toEqual(
      readOnly ? ["MareaReadOnlyStartup"] : [],
    );
    expect(configuration?.interruptOn).toEqual(
      readOnly ? {} : { [unusedTool.name]: { allowedDecisions: ["approve", "edit", "reject"] } },
    );
  });
});

it.each([true, false])(
  "offers the opted-in question tool only outside read-only mode (%s)",
  (readOnly) => {
    const create = vi.mocked(deepagents.createDeepAgent);
    createAgentRuntime({
      model: bindTestModel(new MareaFakeModel()),
      checkpoint: createInMemoryCheckpointForTest(),
      approvalTool: unusedTool,
      systemPrompt: "Tutor",
      questions: true,
      readOnly,
    });
    const configuration = create.mock.calls[0]?.[0];
    expect(configuration?.tools?.map((tool) => tool.name)).toEqual(
      readOnly ? [] : [unusedTool.name, "marea_ask_user"],
    );
    expect(configuration?.interruptOn).toEqual(
      readOnly
        ? {}
        : {
            [unusedTool.name]: { allowedDecisions: ["approve", "edit", "reject"] },
            marea_ask_user: { allowedDecisions: ["approve", "edit", "reject"] },
          },
    );
  },
);
