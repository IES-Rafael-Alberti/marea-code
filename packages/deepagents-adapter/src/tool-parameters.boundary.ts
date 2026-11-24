import * as z from "zod";

/**
 * Named, text-valued parameters of Marea's tools. `key` is what the tool, its approval and its
 * history use; `publicName` is the DeepAgents name the model sees when the meaning matches. The
 * gateway renames between them, and the model may still send `key` as a synonym.
 */
interface ToolParameter {
  readonly key: string;
  readonly publicName?: string;
  readonly description: string;
  readonly required: boolean;
}

const OFFSET: ToolParameter = {
  key: "offset",
  description:
    'Optional. Where to continue reading: the nextOffset of a previous result, as text such as "2000".',
  required: false,
};
const PROJECT_FILE: ToolParameter = {
  key: "path",
  publicName: "file_path",
  description: "Project file path such as /src/main.py; / is the project root.",
  required: true,
};
const BASE_DIRECTORY: ToolParameter = {
  key: "path",
  description: "Optional. Project directory to search from; defaults to / (the project root).",
  required: false,
};

const PARAMETERS: ReadonlyMap<string, readonly ToolParameter[]> = new Map([
  ["marea_read_project", [PROJECT_FILE, OFFSET]],
  [
    "marea_list_project",
    [
      {
        key: "path",
        description: "Project directory path; use / for the project root.",
        required: true,
      },
      OFFSET,
    ],
  ],
  [
    "marea_read_skill",
    [
      { key: "skillId", description: "Skill identifier from the run manifest.", required: true },
      {
        key: "path",
        description: "File inside the skill: SKILL.md or a resource file it names.",
        required: true,
      },
      OFFSET,
    ],
  ],
  [
    "marea_glob_project",
    [
      {
        key: "query",
        publicName: "pattern",
        description: "Glob pattern for file paths, such as **/*.py or src/*.ts.",
        required: true,
      },
      BASE_DIRECTORY,
    ],
  ],
  [
    "marea_search_project",
    [
      {
        key: "query",
        publicName: "pattern",
        description: "Literal text to find in project files (not a regular expression).",
        required: true,
      },
      BASE_DIRECTORY,
    ],
  ],
  [
    "marea_write_file",
    [
      PROJECT_FILE,
      { key: "content", description: "Complete new text of the file.", required: true },
    ],
  ],
  [
    "marea_edit_file",
    [
      PROJECT_FILE,
      {
        key: "old_string",
        description: "Exact text to replace; it must appear once.",
        required: true,
      },
      { key: "new_string", description: "Replacement text.", required: true },
    ],
  ],
  ["marea_delete", [PROJECT_FILE]],
  [
    "marea_execute",
    [
      {
        key: "command",
        description: "The command line to run in the project root.",
        required: true,
      },
    ],
  ],
]);

/** The tool's argument schema; a tool Marea does not describe keeps a free text record. */
export function parameterSchema(tool: string): z.ZodType<Readonly<Record<string, string>>> {
  const parameters = PARAMETERS.get(tool);
  if (parameters === undefined) return z.record(z.string(), z.string());
  return z.object(
    Object.fromEntries(
      parameters.map((parameter) => {
        const value = z.string().describe(parameter.description);
        return [parameter.key, parameter.required ? value : value.optional()];
      }),
    ),
  ) as unknown as z.ZodType<Readonly<Record<string, string>>>;
}

function renamed(tool: string, direction: "public" | "internal"): (name: string) => string {
  const pairs = (PARAMETERS.get(tool) ?? []).flatMap((parameter) =>
    parameter.publicName === undefined ? [] : [[parameter.key, parameter.publicName] as const],
  );
  const map = new Map(
    direction === "public" ? pairs : pairs.map(([key, publicName]) => [publicName, key] as const),
  );
  return (name) => map.get(name) ?? name;
}

function renameArguments(
  tool: string,
  args: Readonly<Record<string, string>>,
  direction: "public" | "internal",
): Readonly<Record<string, string>> {
  const rename = renamed(tool, direction);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(args)) {
    const target = rename(name);
    // A synonym never overwrites the same argument given under its own name.
    if (!(target in result) || target === name) result[target] = value;
  }
  return result;
}

/** Arguments from the model, by public name or synonym, as the tool reads them. */
export function toInternalArguments(
  tool: string,
  args: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return renameArguments(tool, args, "internal");
}

/** Recorded arguments as the model knows them. */
export function toPublicArguments(
  tool: string,
  args: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return renameArguments(tool, args, "public");
}

/** The JSON schema the model sees: the same properties under their public names. */
export function toPublicInputSchema(
  tool: string,
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rename = renamed(tool, "public");
  const properties = schema.properties;
  const required = schema.required;
  return {
    ...schema,
    ...(typeof properties === "object" && properties !== null
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, value]) => [rename(name), value as unknown]),
          ),
        }
      : {}),
    ...(Array.isArray(required)
      ? {
          required: (required as readonly unknown[]).map((name) =>
            typeof name === "string" ? rename(name) : name,
          ),
        }
      : {}),
  };
}
