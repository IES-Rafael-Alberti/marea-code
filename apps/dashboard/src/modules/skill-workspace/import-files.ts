import { SkillAuthoringDraftSchema, type SkillAuthoringDraft } from "@marea/protocol";
import {
  readSkillAuthoringFiles,
  type SkillAuthoringImportFile,
} from "../skill-authoring/skill-authoring-files.js";
import { renameSkillDraft } from "./draft.boundary.js";

/** Merge explicit text resources without requiring teachers to import a complete bundle. */
export async function importSkillFiles(
  draft: SkillAuthoringDraft,
  selected: readonly SkillAuthoringImportFile[],
): Promise<SkillAuthoringDraft> {
  const main = draft.files.find((file) => file.path === "SKILL.md");
  if (!main || selected.length === 0) throw new Error("invalid");
  const includesMain = selected.some((entry) => entry.path === "SKILL.md");
  const imported = await readSkillAuthoringFiles([
    ...(includesMain ? [] : [{ path: "SKILL.md", file: new Blob([main.content]) }]),
    ...selected.map((entry) => ({
      ...entry,
      path:
        entry.path === "SKILL.md" || entry.path.startsWith("resources/")
          ? entry.path
          : `resources/${entry.path}`,
    })),
  ]);
  const merged = SkillAuthoringDraftSchema.parse({
    ...draft,
    files: [
      ...draft.files.filter((file) => !imported.some((entry) => entry.path === file.path)),
      ...imported,
    ],
  });
  return includesMain ? renameSkillDraft(merged, draft.slug) : merged;
}
