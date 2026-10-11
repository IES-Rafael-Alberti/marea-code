import { parseDocument } from "yaml";
import * as z from "zod";
import {
  SkillAuthoringDraftSchema,
  SkillFrontmatterSchema,
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
    data: value,
    instructions: file.content.slice(match[0].length),
  };
}

export function skillEditorFields(draft: SkillAuthoringDraft): SkillEditorFields | null {
  try {
    const parsed = documentOf(draft);
    const data = fields.parse(parsed.data);
    const instructions = parsed.instructions;
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
        content: `---\nname: ${slug}\ndescription: ''\nmetadata:\n  title: ''\n# Completa la descripción y el título. Conserva name al editar una skill existente.\n${kind === "didactic" ? "# Opcional: criterios con codigo, enunciado y exactamente cuatro niveles.\n# criterios:\n#   - codigo: local-1\n#     enunciado: Qué debe demostrar el alumno\n#     niveles: [Con guía, Con ayuda puntual, De forma autónoma, En situaciones nuevas]\n" : ""}---\n\n${kind === "didactic" ? "# Lo que tiene que dominar\n\n<!-- Objetivos y progresión del aprendizaje. -->\n\n## Cómo plantear el ejercicio\n\n<!-- Situación, preguntas y ayudas. -->\n\n## Qué no hacer\n\n<!-- Decisiones que debe tomar el alumno. -->\n\n## Cómo saber si lo ha entendido\n\n<!-- Evidencias observables y respuesta a las dificultades. -->" : "# Cómo evaluar\n\n<!-- Método para revisar la evidencia, sin inventar aprendizajes. -->\n\n## El borrador para revisar\n\n<!-- Formato del feedback para el alumno y las notas privadas del profesor. -->\n\n## Reglas\n\n<!-- Distingue falta de evidencia y aprendizaje no demostrado. -->"}\n`,
      },
    ],
  };
}

/** Keep the exact Markdown, comments, ordering and every pre-existing companion file. */
export function editSkillMarkdown(
  draft: SkillAuthoringDraft,
  content: string,
  allowRename: boolean,
): SkillAuthoringDraft {
  const next = {
    ...draft,
    files: draft.files.map((file) => (file.path === "SKILL.md" ? { ...file, content } : file)),
  };
  try {
    const name: unknown = documentOf(next).document.get("name");
    const slug = SkillAuthoringDraftSchema.unwrap().shape.slug.safeParse(name);
    if (allowRename && slug.success) return { ...next, slug: slug.data };
  } catch {
    /* Keep incomplete Markdown editable. */
  }
  return next;
}

export function skillDraftProblem(draft: SkillAuthoringDraft) {
  if (!SkillAuthoringDraftSchema.safeParse(draft).success) return "invalidSize";
  try {
    const { data, instructions, document } = documentOf(draft);
    const parsed = SkillFrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      // Stryker disable next-line OptionalChaining: A failed Zod parse always has an issue; optional access only satisfies indexed-access typing.
      const path = parsed.error.issues[0]?.path[0];
      return path === "description"
        ? "invalidDescription"
        : path === "criterios"
          ? "invalidCriteria"
          : "invalidYaml";
    }
    if (parsed.data.name !== draft.slug) return "invalidName";
    if (parsed.data.module !== undefined || parsed.data["allowed-tools"] !== undefined)
      return "invalidYaml";
    if (draft.kind === "evaluation" && document.has("criterios")) return "invalidCriteria";
    if (instructions.trim().length === 0) return "invalidBody";
    const criteria = parsed.data.criterios;
    if (
      criteria !== undefined &&
      new Set(criteria.map((criterion) => criterion.codigo)).size !== criteria.length
    )
      return "invalidCriteria";
    return null;
  } catch {
    return "invalidYaml";
  }
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
  return skillDraftProblem(draft) === null;
}
