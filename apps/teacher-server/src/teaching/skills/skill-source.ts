import { SkillIdSchema, type Sha256Digest, type SkillId } from "@marea/protocol";

export type { SkillId } from "@marea/protocol";

export type SkillKind = "didactic" | "evaluation";

export type SkillProvenance = "marea" | "teacher" | "center";

export interface SkillCriterion {
  readonly code: string;
  readonly statement: string;
  readonly levels: readonly [string, string, string, string] | null;
}

export interface SkillSummary {
  readonly id: SkillId;
  readonly name: string;
  readonly description: string;
  readonly kind: SkillKind;
  readonly source: SkillProvenance;
  readonly digest: Sha256Digest;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly criteria: readonly SkillCriterion[];
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface SkillBundle extends SkillSummary {
  readonly files: readonly SkillFile[];
}

export interface SkillSource {
  list(kind: SkillKind): Promise<readonly SkillSummary[]>;
  load(id: SkillId): Promise<SkillBundle | null>;
}

export function summarizeSkill(bundle: SkillBundle): SkillSummary {
  return Object.freeze({
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    kind: bundle.kind,
    source: bundle.source,
    digest: bundle.digest,
    license: bundle.license,
    compatibility: bundle.compatibility,
    criteria: bundle.criteria,
  });
}

const PORTABLE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function parseSkillId(value: string): SkillId | null {
  const result = SkillIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function bundledSkillId(name: string): SkillId {
  if (!isValidSkillName(name)) {
    throw new TypeError(`Invalid bundled skill name: ${name}`);
  }
  return SkillIdSchema.parse(`marea/${name}`);
}

export function isValidSkillName(name: string): boolean {
  return name.length <= 64 && PORTABLE_SKILL_NAME.test(name);
}
