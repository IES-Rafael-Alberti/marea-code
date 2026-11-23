import { parseDocument } from "yaml";
import type * as z from "zod";
import { SkillFrontmatterSchema } from "@marea/protocol";

import { BundledSkillError } from "./errors.js";
import type { SkillCriterion, SkillKind } from "./skill-source.js";
import { isValidSkillName } from "./skill-source.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u;

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
  const result = SkillFrontmatterSchema.safeParse(raw);
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

function hasDuplicateCriterionCode(
  criteria: readonly NonNullable<z.infer<typeof SkillFrontmatterSchema>["criterios"]>[number][],
): boolean {
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

function toCriterion(
  criterion: NonNullable<z.infer<typeof SkillFrontmatterSchema>["criterios"]>[number],
): SkillCriterion {
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
