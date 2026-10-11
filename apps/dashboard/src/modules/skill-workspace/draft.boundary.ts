import { parseDocument } from "yaml";
import * as z from "zod";
import {
  SkillAuthoringDraftSchema,
  SkillCriterionSchema,
  type SkillAuthoringDraft,
} from "@marea/protocol";
import { browserRandomUUID } from "../../browser-random-uuid.js";

const fields = z
  .object({
    name: z.string(),
    description: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
    criterios: z
      .array(
        z.object({
          codigo: z.string(),
          enunciado: z.string().default(""),
          niveles: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional(),
        }),
      )
      .default([]),
  })
  .loose();
export interface SkillEditorFields {
  readonly title: string;
  readonly description: string;
  readonly instructions: string;
  readonly criteria: z.infer<typeof fields>["criterios"];
}

function documentOf(draft: SkillAuthoringDraft) {
  const file = draft.files.find((item) => item.path === "SKILL.md");
  if (!file) throw new Error("invalid");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(file.content);
  if (match?.[1] === undefined) throw new Error("invalid");
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) throw new Error("invalid");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return {
    document,
    data: fields.parse(value),
    instructions: file.content.slice(match[0].length),
  };
}

export function skillEditorFields(draft: SkillAuthoringDraft): SkillEditorFields | null {
  try {
    const { data, instructions } = documentOf(draft);
    return {
      title: data.metadata?.title ?? data.name.replaceAll("-", " "),
      description: data.description,
      instructions,
      criteria: data.criterios,
    };
  } catch {
    return null;
  }
}

/** YAML document edits preserve imported metadata/comments and all companion files. */
export function editSkillFields(
  draft: SkillAuthoringDraft,
  update: Partial<SkillEditorFields>,
): SkillAuthoringDraft {
  const { document, instructions } = documentOf(draft);
  if (update.title !== undefined) document.setIn(["metadata", "title"], update.title);
  if (update.description !== undefined) document.set("description", update.description);
  if (update.criteria !== undefined) document.set("criterios", update.criteria);
  const content = `---\n${document.toString()}---\n${update.instructions ?? instructions}`;
  return {
    ...draft,
    files: draft.files.map((file) => (file.path === "SKILL.md" ? { ...file, content } : file)),
  };
}

export function newSkillDraft(kind: SkillAuthoringDraft["kind"]): SkillAuthoringDraft {
  const slug = `skill-${browserRandomUUID()}`;
  return {
    slug,
    kind,
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${slug}\ndescription: ''\nmetadata:\n  title: ''\n---\n`,
      },
    ],
  };
}

export function copySkillDraft(draft: SkillAuthoringDraft): SkillAuthoringDraft {
  const next = newSkillDraft(draft.kind);
  return renameSkillDraft(draft, next.slug);
}

export function renameSkillDraft(draft: SkillAuthoringDraft, slug: string): SkillAuthoringDraft {
  const { document, instructions } = documentOf(draft);
  document.set("name", slug);
  return {
    ...draft,
    slug,
    files: draft.files.map((file) =>
      file.path === "SKILL.md"
        ? { ...file, content: `---\n${document.toString()}---\n${instructions}` }
        : file,
    ),
  };
}

export function validSkillDraft(draft: SkillAuthoringDraft): boolean {
  const fields = skillEditorFields(draft);
  return (
    SkillAuthoringDraftSchema.safeParse(draft).success &&
    fields !== null &&
    fields.title.trim().length > 0 &&
    fields.title.length <= 256 &&
    fields.description.trim().length > 0 &&
    fields.description.length <= 1024 &&
    fields.instructions.trim().length > 0 &&
    (draft.kind === "didactic" || fields.criteria.length === 0) &&
    fields.criteria.length <= 64 &&
    new Set(fields.criteria.map((item) => item.codigo.trim())).size === fields.criteria.length &&
    fields.criteria.every(
      (item) =>
        SkillCriterionSchema.safeParse({
          code: item.codigo.trim(),
          statement: item.enunciado,
          levels: item.niveles ?? null,
        }).success,
    )
  );
}
