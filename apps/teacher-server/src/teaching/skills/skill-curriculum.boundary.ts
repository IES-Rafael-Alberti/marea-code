import { parseDocument } from "yaml";
import { SkillFrontmatterSchema, type SkillCurriculumSummary } from "@marea/protocol";
import type { SkillBundle } from "./skill-source.js";

/** Metadata stays in SKILL.md; baseline student bundles and historical criteria remain unchanged. */
export function skillCurriculum(bundle: SkillBundle | null): SkillCurriculumSummary {
  const main = bundle?.files.find((file) => file.path === "SKILL.md");
  if (main === undefined) return { modulos: [], referencias: [] };
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(main.content)?.[1];
  if (yaml === undefined) return { modulos: [], referencias: [] };
  const parsed = SkillFrontmatterSchema.parse(parseDocument(yaml).toJS({ maxAliasCount: 0 }));
  const referencias = parsed.criterios?.flatMap((criterion) => criterion.referencias ?? []) ?? [];
  return {
    modulos: [
      ...(parsed.curriculo?.modulos ?? []),
      ...referencias.map((reference) => reference.modulo),
    ],
    referencias,
  };
}
