import { projectSearchTools } from "./project-search.js";
import type { ReadOnlyTool } from "@marea/deepagents-adapter";
import type { StudentRunSnapshot } from "@marea/protocol";
import type { WorkspaceBackend } from "@marea/workspace-backend";
import * as z from "zod";

import { readToolPage } from "./read-tool-page.js";

export interface RuntimeReadToolsOptions {
  readonly snapshot: StudentRunSnapshot;
  readonly workspace: Pick<WorkspaceBackend, "readText" | "list">;
  readonly skills: { read(skillId: string, path: string): Promise<string> };
}

const PathSchema = z
  .object({
    path: z.string().min(1),
    offset: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,12})(?![\s\S])/)
      .prefault("0")
      .transform(Number),
  })
  .strict();
const SkillPathSchema = PathSchema.extend({ skillId: z.string().min(1) });
const PAGING =
  " Returns JSON with content, offset, nextOffset and totalLength; pass nextOffset as the optional string offset to continue. Offsets count UTF-16 code units.";

/** Read tools never authorize writes; guarded backends enforce path containment. */
export function createRuntimeReadTools(options: RuntimeReadToolsOptions): readonly ReadOnlyTool[] {
  const allowed = (name: string) =>
    !options.snapshot.teacherToolPolicy.restrictions.some((rule) => rule.tool === name);
  const tools: ReadOnlyTool[] = [];
  if (allowed("read_file")) {
    tools.push({
      name: "marea_read_project",
      description:
        "Read UTF-8 project text. Arguments: path, a virtual path such as /src/main.ts (root is the project)." +
        PAGING,
      execute: (input) => {
        const parsed = PathSchema.parse(input);
        return options.workspace
          .readText(parsed.path)
          .then((text) => readToolPage(text, parsed.offset));
      },
    });
  }
  if (allowed("list_directory")) {
    tools.push({
      name: "marea_list_project",
      description:
        "List a project directory as JSON text. Arguments: path; use / for the project root." +
        PAGING,
      execute: async (input) => {
        const parsed = PathSchema.parse(input);
        return readToolPage(
          JSON.stringify(
            (await options.workspace.list(parsed.path)).filter(
              (entry) => entry.path.split("/").at(-1) !== ".git",
            ),
          ),
          parsed.offset,
        );
      },
    });
  }
  if (options.snapshot.agentMode !== "free" && allowed("read_skill")) {
    tools.push({
      name: "marea_read_skill",
      description:
        "Read a frozen didactic skill. Arguments: skillId from the run manifest, path must name a file (SKILL.md or an exact resource file referenced there), not a directory. Do not guess resource paths." +
        PAGING,
      execute: (input) => {
        const parsed = SkillPathSchema.parse(input);
        return options.skills
          .read(parsed.skillId, parsed.path)
          .then((text) => readToolPage(text, parsed.offset));
      },
    });
  }
  if (allowed("list_directory"))
    tools.push(
      ...projectSearchTools(options.workspace).filter((tool) =>
        tool.name === "marea_glob_project"
          ? allowed("glob")
          : allowed("grep") && allowed("read_file"),
      ),
    );
  return Object.freeze(tools);
}
