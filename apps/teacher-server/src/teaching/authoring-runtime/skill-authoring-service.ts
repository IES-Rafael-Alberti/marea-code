import { parseDocument } from "yaml";

import {
  SkillAuthoringCopyResponseSchema,
  SkillAuthoringCopyRequestSchema,
  SkillAuthoringReadRequestSchema,
  SkillAuthoringReadResponseSchema,
  SkillAuthoringSaveRequestSchema,
  SkillAuthoringValidateRequestSchema,
  SkillAuthoringValidateResponseSchema,
  SkillAuthoringSaveResponseSchema,
  SkillIdSchema,
  type SkillAuthoringCopyRequest,
  type SkillAuthoringCopyResponse,
  type SkillAuthoringDraft,
  type SkillAuthoringReadRequest,
  type SkillAuthoringReadResponse,
  type SkillAuthoringSaveRequest,
  type SkillAuthoringSaveResponse,
  type SkillAuthoringValidateRequest,
  type SkillAuthoringValidateResponse,
  type SkillId,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { ProductSkillAuthoringService } from "../authoring/dashboard-contracts.js";
import type { TeachingConfigurationRepository } from "../configuration/contracts.js";
import type { SkillBundle as ServerSkillBundle, SkillSource } from "../skills/skill-source.js";
import {
  type SkillAuthoringFile,
  type SkillAuthoringPublicationGuard,
  type SkillSaveRequest,
} from "../authoring/skill-authoring-store.boundary.js";
import { SkillAuthoringError } from "../authoring/errors.js";

/** A trusted writer already initialized for one teacher's owner root. */
export interface ProductSkillAuthoringWriter {
  read(id: string): Promise<ServerSkillBundle | null>;
  validate(
    kind: SkillSaveRequest["kind"],
    slug: string,
    files: readonly SkillAuthoringFile[],
  ): Promise<ServerSkillBundle | null>;
  create(
    request: SkillSaveRequest,
    beforePublish?: SkillAuthoringPublicationGuard,
  ): Promise<ServerSkillBundle>;
  replace(
    request: SkillSaveRequest,
    beforePublish?: SkillAuthoringPublicationGuard,
  ): Promise<ServerSkillBundle>;
}

/** Trusted host dependencies for the teacher-scoped authoring service. */
export interface ProductSkillAuthoringServiceOptions {
  /** Membership is the existing transactional teacher/class authorization port. */
  readonly membership: Pick<TeachingConfigurationRepository, "requireTeacherClass">;
  /** Resolves the initialized owner-scoped W03 writer for the authenticated teacher. */
  readonly writerForTeacher: (teacherId: string) => ProductSkillAuthoringWriter;
  /** Resolves the already-authorized class composite source for catalog reads/copies. */
  readonly sourceForTeacherClass: (teacherId: string, classId: string) => SkillSource;
}

export class SkillAuthoringServiceError extends Error {
  constructor(readonly code: "source-unavailable" | "invalid-canonical") {
    super(`Skill authoring operation failed: ${code}.`);
    this.name = "SkillAuthoringServiceError";
  }
}

/** Builds the ProductSkillAuthoringService implementation for later host composition. */
export function createProductSkillAuthoringService(
  options: ProductSkillAuthoringServiceOptions,
): ProductSkillAuthoringService {
  const service = new ProductSkillAuthoringServiceImpl(options);
  return Object.freeze({
    read: service.read.bind(service),
    validate: service.validate.bind(service),
    save: service.save.bind(service),
    copy: service.copy.bind(service),
  });
}

/** Main-facing module construction shape, matching the existing teaching module. */
export function createSkillAuthoringModule(options: ProductSkillAuthoringServiceOptions): {
  readonly service: ProductSkillAuthoringService;
} {
  return Object.freeze({ service: createProductSkillAuthoringService(options) });
}

class ProductSkillAuthoringServiceImpl implements ProductSkillAuthoringService {
  readonly #options: ProductSkillAuthoringServiceOptions;

  constructor(options: ProductSkillAuthoringServiceOptions) {
    this.#options = options;
  }

  async read(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringReadRequest,
  ): Promise<SkillAuthoringReadResponse> {
    const parsed = SkillAuthoringReadRequestSchema.parse(request);
    this.#requireMembership(identity, parsed.classId);
    const skill =
      parsed.target.scope === "personal"
        ? await this.#readPersonal(identity, parsed.target.slug)
        : await this.#readCatalog(identity, parsed.classId, parsed.target.skillId);
    this.#requireMembership(identity, parsed.classId);
    return SkillAuthoringReadResponseSchema.parse({
      classId: parsed.classId,
      editable:
        skill !== null &&
        // SkillBundleSchema enforces the source prefix, so the canonical owner ID is authoritative.
        skill.id === `teacher/${identity.userId}/${skill.name}`,
      kind: "skill-authoring-read-result",
      protocolVersion: parsed.protocolVersion,
      requestId: parsed.requestId,
      skill,
    });
  }

  async validate(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringValidateRequest,
  ): Promise<SkillAuthoringValidateResponse> {
    const parsed = SkillAuthoringValidateRequestSchema.parse(request);
    this.#requireMembership(identity, parsed.classId);
    const writer = this.#options.writerForTeacher(identity.userId);
    const skill = await writer.validate(
      parsed.draft.kind,
      parsed.draft.slug,
      toAuthoringFiles(parsed.draft),
    );
    this.#requireMembership(identity, parsed.classId);
    return SkillAuthoringValidateResponseSchema.parse({
      classId: parsed.classId,
      kind: "skill-authoring-validated",
      protocolVersion: parsed.protocolVersion,
      requestId: parsed.requestId,
      skill: this.#requirePersonalBundle(skill, identity, parsed.draft),
    });
  }

  async save(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringSaveRequest,
  ): Promise<SkillAuthoringSaveResponse> {
    const parsed = SkillAuthoringSaveRequestSchema.parse(request);
    this.#requireMembership(identity, parsed.classId);
    const writer = this.#options.writerForTeacher(identity.userId);
    const saveRequest = toSaveRequest(parsed.draft, parsed.expectedDigest);
    const guard = (): void => {
      this.#requireMembership(identity, parsed.classId);
    };
    const skill =
      parsed.expectedDigest === null
        ? await writer.create(saveRequest, guard)
        : await writer.replace(saveRequest, guard);
    return SkillAuthoringSaveResponseSchema.parse({
      classId: parsed.classId,
      kind: "skill-authoring-saved",
      protocolVersion: parsed.protocolVersion,
      requestId: parsed.requestId,
      skill: this.#requirePersonalBundle(skill, identity, parsed.draft),
    });
  }

  async copy(
    identity: AuthenticatedIdentity,
    request: SkillAuthoringCopyRequest,
  ): Promise<SkillAuthoringCopyResponse> {
    const parsed = SkillAuthoringCopyRequestSchema.parse(request);
    this.#requireMembership(identity, parsed.classId);
    const source = this.#options.sourceForTeacherClass(identity.userId, parsed.classId);
    const sourceSkill = await source.load(parsed.sourceSkillId);
    this.#requireMembership(identity, parsed.classId);
    if (sourceSkill === null) {
      throw new SkillAuthoringError(
        "SKILL_MISSING",
        parsed.sourceSkillId,
        "The authorized source skill is unavailable.",
      );
    }
    if (sourceSkill.digest !== parsed.sourceDigest) {
      throw new SkillAuthoringError(
        "STALE_SKILL_DIGEST",
        parsed.sourceSkillId,
        "The source skill has changed; read it again before copying.",
      );
    }
    const draft = copyDraft(sourceSkill, parsed.slug);
    const writer = this.#options.writerForTeacher(identity.userId);
    const skill = await writer.create(toSaveRequest(draft, null), () => {
      this.#requireMembership(identity, parsed.classId);
    });
    return SkillAuthoringCopyResponseSchema.parse({
      classId: parsed.classId,
      kind: "skill-authoring-copied",
      protocolVersion: parsed.protocolVersion,
      requestId: parsed.requestId,
      skill: this.#requirePersonalBundle(skill, identity, draft),
    });
  }

  async #readPersonal(
    identity: AuthenticatedIdentity,
    slug: string,
  ): Promise<ServerSkillBundle | null> {
    const writer = this.#options.writerForTeacher(identity.userId);
    const id = SkillIdSchema.parse(`teacher/${identity.userId}/${slug}`);
    const skill = await writer.read(id);
    if (skill !== null && !this.#isPersonalBundle(skill, identity)) {
      throw new SkillAuthoringServiceError("invalid-canonical");
    }
    return skill;
  }

  async #readCatalog(
    identity: AuthenticatedIdentity,
    classId: string,
    skillId: SkillId,
  ): Promise<ServerSkillBundle | null> {
    const source = this.#options.sourceForTeacherClass(identity.userId, classId);
    return source.load(skillId);
  }

  #requireMembership(identity: AuthenticatedIdentity, classId: string): void {
    if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
    this.#options.membership.requireTeacherClass(identity.userId, classId);
  }

  #requirePersonalBundle(
    skill: ServerSkillBundle | null,
    identity: AuthenticatedIdentity,
    draft: SkillAuthoringDraft,
  ): ServerSkillBundle {
    if (skill === null || !this.#isPersonalBundle(skill, identity) || skill.name !== draft.slug) {
      throw new SkillAuthoringServiceError("invalid-canonical");
    }
    return skill;
  }

  #isPersonalBundle(skill: ServerSkillBundle, identity: AuthenticatedIdentity): boolean {
    return skill.source === "teacher" && skill.id === `teacher/${identity.userId}/${skill.name}`;
  }
}

function toAuthoringFiles(draft: SkillAuthoringDraft): readonly SkillAuthoringFile[] {
  return draft.files.map(({ path, content }) => ({ path, content }));
}

function toSaveRequest(
  draft: SkillAuthoringDraft,
  expectedDigest: SkillAuthoringSaveRequest["expectedDigest"],
): SkillSaveRequest {
  return {
    expectedDigest,
    files: toAuthoringFiles(draft),
    kind: draft.kind,
    slug: draft.slug,
  };
}

function copyDraft(source: ServerSkillBundle, slug: string): SkillAuthoringDraft {
  const skillFile = source.files.find(({ path }) => path === "SKILL.md");
  if (skillFile === undefined) throw new SkillAuthoringServiceError("invalid-canonical");
  const files = source.files.map(({ content, path }) => ({
    content: path === "SKILL.md" ? renameFrontmatter(skillFile.content, slug) : content,
    path,
  }));
  return { files: files.map(({ path, content }) => ({ path, content })), kind: source.kind, slug };
}

function renameFrontmatter(content: string, slug: string): string {
  const match = /^---\n[\s\S]*?\n---\n/u.exec(content);
  if (match === null) throw new SkillAuthoringServiceError("invalid-canonical");
  const matchedFrontmatter = match[0];
  const frontmatterEnd = matchedFrontmatter.lastIndexOf("\n---\n");
  const document = parseDocument(content.slice("---\n".length, frontmatterEnd));
  if (document.errors.length > 0 || typeof document.get("name") !== "string") {
    throw new SkillAuthoringServiceError("invalid-canonical");
  }
  document.set("name", slug);
  const serialized = document.toString().replace(/\n$/u, "");
  return `---\n${serialized}\n---\n${content.slice(matchedFrontmatter.length)}`;
}
