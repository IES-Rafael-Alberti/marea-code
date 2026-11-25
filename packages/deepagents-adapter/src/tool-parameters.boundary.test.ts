import { describe, expect, it } from "vitest";
import * as z from "zod";

import { parameterSchema } from "./tool-parameters.boundary.js";

function described(tool: string) {
  return z.toJSONSchema(parameterSchema(tool));
}

describe("tool parameter schemas", () => {
  it("asks for the directory to list and an optional offset", () => {
    expect(described("marea_list_project")).toMatchObject({
      properties: {
        path: {
          type: "string",
          description: "Project directory path; use / for the project root.",
        },
        offset: { type: "string" },
      },
      required: ["path"],
    });
  });

  it("asks for the command line to run", () => {
    expect(described("marea_execute")).toMatchObject({
      properties: {
        command: { type: "string", description: "The command line to run in the project root." },
      },
      required: ["command"],
    });
  });

  it("keeps a free text record for a tool Marea does not describe", () => {
    expect(parameterSchema("other_tool").parse({ any: "text" })).toEqual({ any: "text" });
  });
});
