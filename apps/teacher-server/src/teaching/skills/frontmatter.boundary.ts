import { parseDocument } from "yaml";
import * as z from "zod";

import { BundledSkillError } from "./errors.js";
import type { SkillCriterion, SkillKind } from "./skill-source.js";
import { isValidSkillName } from "./skill-source.js";

const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMPATIBILITY_LENGTH = 500;
const MAX_CRITERIA = 64;
const MAX_CRITERION_CODE_LENGTH = 64;
const MAX_CRITERION_TEXT_LENGTH = 1_024;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

const trimmedText = z.string().trim().min(1);
const criterionCode = trimmedText
  .max(MAX_CRITERION_CODE_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionStatement = z
  .string()
  .trim()
  .max(MAX_CRITERION_TEXT_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionLevel = trimmedText
  .max(MAX_CRITERION_TEXT_LENGTH)
  .refine(withoutControlCharacters, "Control characters are not allowed.");
const criterionSchema = z
  .object({
    codigo: criterionCode,
    enunciado: criterionStatement.default(""),
    niveles: z.tuple([criterionLevel, criterionLevel, criterionLevel, criterionLevel]).optional(),
  })
  .strict();

const frontmatterSchema = z
  .object({
    name: trimmedText,
    description: trimmedText.max(MAX_DESCRIPTION_LENGTH),
    license: trimmedText.optional(),
    compatibility: trimmedText.max(MAX_COMPATIBILITY_LENGTH).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.unknown().optional(),
    module: trimmedText.optional(),
    criterios: z.array(criterionSchema).max(MAX_CRITERIA).optional(),
  })
  .strict();

export interface ParsedSkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly criteria: readonly SkillCriterion[];
}

export function parseSkillFrontmatter(
  content: string,
  directoryName: string,
  kind: SkillKind,
  location: string,
): ParsedSkillFrontmatter {
  const match = FRONTMATTER.exec(content);
  const source = match?.[1];
  if (source === undefined) {
    throw invalidFrontmatter(
      location,
      "Add YAML frontmatter delimited by `---` at the start of SKILL.md.",
    );
  }

  const raw = parseYamlMapping(source, location);
  const result = frontmatterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const field = issue.path.join(".") || "frontmatter";
        return `Fix ${field}: ${issue.message}`;
      })
      .join("; ");
    throw invalidFrontmatter(location, issues);
  }

  const data = result.data;
  if (!isValidSkillName(data.name)) {
    throw invalidFrontmatter(
      location,
      "Use a 1-64 character portable name containing only ASCII lowercase letters, numbers, and single hyphens.",
    );
  }
  if (data.name !== directoryName) {
    throw invalidFrontmatter(
      location,
      `Rename the directory to '${data.name}' or set name to '${directoryName}'.`,
    );
  }
  if (data.module !== undefined) {
    throw invalidFrontmatter(
      location,
      "Remove `module`; Marea educational skills cannot execute code.",
    );
  }
  if (data["allowed-tools"] !== undefined) {
    throw invalidFrontmatter(
      location,
      "Remove `allowed-tools`; educational skill metadata cannot grant tool permissions.",
    );
  }
  if (kind === "evaluation" && data.criterios !== undefined) {
    throw invalidFrontmatter(
      location,
      "Remove `criterios`; evaluation skills define evaluation method, not learning criteria.",
    );
  }
  if (data.criterios !== undefined && hasDuplicateCriterionCode(data.criterios)) {
    throw invalidFrontmatter(location, "Give each criterion a unique `codigo` within the skill.");
  }

  return Object.freeze({
    name: data.name,
    description: data.description,
    license: data.license ?? null,
    compatibility: data.compatibility ?? null,
    criteria: Object.freeze((data.criterios ?? []).map(toCriterion)),
  });
}

function withoutControlCharacters(value: string): boolean {
  return !CONTROL_CHARACTER.test(value);
}

function hasDuplicateCriterionCode(criteria: readonly z.infer<typeof criterionSchema>[]): boolean {
  const codes = criteria.map((criterion) => criterion.codigo);
  return new Set(codes).size !== codes.length;
}

function parseYamlMapping(source: string, location: string): object {
  const document = parseYamlDocument(source, location);
  const parseError = document.errors[0];
  if (parseError !== undefined) {
    throw invalidFrontmatter(location, `Fix the YAML syntax: ${parseError.message}`);
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error: unknown) {
    const detail = String(error);
    throw invalidFrontmatter(location, `Fix the YAML syntax: ${detail}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidFrontmatter(location, "Use a YAML mapping for the frontmatter.");
  }
  return raw;
}

function parseYamlDocument(source: string, location: string): ReturnType<typeof parseDocument> {
  try {
    return parseDocument(source);
  } catch (error: unknown) {
    const detail = String(error);
    throw invalidFrontmatter(location, `Fix the YAML syntax: ${detail}`);
  }
}

function toCriterion(criterion: z.infer<typeof criterionSchema>): SkillCriterion {
  return Object.freeze({
    code: criterion.codigo,
    statement: criterion.enunciado,
    levels: criterion.niveles === undefined ? null : Object.freeze(criterion.niveles),
  });
}

function invalidFrontmatter(location: string, action: string): BundledSkillError {
  return new BundledSkillError(
    "INVALID_FRONTMATTER",
    location,
    `Invalid frontmatter in ${location}. ${action}`,
  );
}
