import { skillCurriculum } from "./skill-curriculum.boundary.js";
import { parseDocument } from "yaml";
import {
  SkillWorkspaceRequestSchema,
  SkillWorkspaceResponseSchema,
  type SkillWorkspaceRequest,
} from "@marea/protocol";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { SqliteSkillAssignments } from "../../platform/persistence/sqlite-skill-assignments.js";
import { materializeTeachingSkills } from "./materialize-skills.js";
import type { SkillSource, SkillBundle, SkillSummary } from "./skill-source.js";
import type { SkillGenerator } from "./generate-skill.js";
import type { SkillAuthoringStore } from "../authoring/skill-authoring-store.boundary.js";

export interface SkillWorkspaceTools {
  readonly generator: Pick<SkillGenerator, "generate">;
  readonly writerForTeacher: (teacherId: string) => Pick<SkillAuthoringStore, "remove">;
}

export class SkillWorkspaceService {
  constructor(
    readonly repository: SqliteSkillAssignments,
    readonly source: (teacherId: string, classId: string) => SkillSource,
    readonly tools?: SkillWorkspaceTools,
  ) {}
  async execute(
    identity: AuthenticatedIdentity,
    input: SkillWorkspaceRequest,
    signal = new AbortController().signal,
  ) {
    const request = SkillWorkspaceRequestSchema.parse(input);
    this.repository.require(identity, request.classId);
    const envelope = {
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
      classId: request.classId,
    };
    switch (request.kind) {
      case "generate": {
        if (!this.tools) throw new Error("unavailable");
        const content = await this.tools.generator.generate(identity.userId, request, signal);
        this.repository.require(identity, request.classId);
        return SkillWorkspaceResponseSchema.parse({ ...envelope, kind: "generate", content });
      }
      case "delete": {
        if (!request.skillId.startsWith(`teacher/${identity.userId}/`))
          throw new TeacherDomainError("dashboard.forbidden");
        if (!this.tools) throw new Error("unavailable");
        await this.tools
          .writerForTeacher(identity.userId)
          .remove(request.skillId, request.digest, () => {
            this.repository.withdraw(
              identity,
              request.classId,
              request.skillId,
              request.expectedUsage,
            );
          });
        return SkillWorkspaceResponseSchema.parse({ ...envelope, kind: "delete" });
      }
      case "library": {
        const source = this.source(identity.userId, request.classId);
        const catalog = new Map(
          [...(await source.list("didactic")), ...(await source.list("evaluation"))].map(
            (entry) => [entry.id, entry] as const,
          ),
        );
        // Default string sorting matches the cursor's code-unit ordering on every host locale.
        const entries = [...catalog.keys()]
          .sort()
          .filter((id) => request.after === null || id > request.after)
          // Every key comes from this same, unmodified map.
          // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
          .map((id) => catalog.get(id) as SkillSummary);
        const skills = await Promise.all(
          entries.slice(0, 100).map(async (entry) => {
            const bundle = await source.load(entry.id);
            const title = humanTitle(bundle);
            return {
              ...(request.includeCurriculum ? { curriculum: skillCurriculum(bundle) } : {}),
              id: entry.id,
              name: entry.name,
              description: entry.description,
              kind: entry.kind,
              source: entry.source,
              digest: entry.digest,
              compatibility: entry.compatibility,
              title: title ?? entry.name.replaceAll("-", " "),
            };
          }),
        );
        const cursor = skills.reduce<string | null>((_, item) => item.id, null);
        this.repository.require(identity, request.classId);
        return SkillWorkspaceResponseSchema.parse({
          ...envelope,
          kind: "library",
          skills,
          next: entries.length > 100 ? cursor : null,
        });
      }
      case "students":
        return SkillWorkspaceResponseSchema.parse({
          ...envelope,
          kind: "students",
          ...this.repository.students(request.classId, request.after),
        });
      case "usage":
        return SkillWorkspaceResponseSchema.parse({
          ...envelope,
          kind: "usage",
          ...this.repository.usage(identity.userId, request.skillId),
        });
      case "assign": {
        const captured =
          request.selection === null
            ? null
            : await materializeTeachingSkills(this.source(identity.userId, request.classId), {
                // Stryker disable next-line StringLiteral: Only free mode skips materialization; every other value follows the same capture path. The type admits only these two modes.
                agentMode: "tutoring",
                didactic: request.selection,
                evaluation: [],
              });
        this.repository.assign(identity, request, captured?.didactic ?? null);
        return SkillWorkspaceResponseSchema.parse({ ...envelope, kind: "assigned" });
      }
      case "apply": {
        if (!request.skillId.startsWith(`teacher/${identity.userId}/`))
          throw new TeacherDomainError("dashboard.forbidden");
        const bundle = await this.source(identity.userId, request.classId).load(request.skillId);
        if (bundle?.digest !== request.digest) throw new TeacherDomainError("request.conflict");
        this.repository.apply(identity, request.classId, bundle, request.expectedUsage);
        return SkillWorkspaceResponseSchema.parse({ ...envelope, kind: "applied" });
      }
    }
  }
}

function humanTitle(bundle: SkillBundle | null): string | undefined {
  const main = bundle?.files.find((file) => file.path === "SKILL.md");
  if (main === undefined) return undefined;
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(main.content)?.[1];
  if (yaml === undefined) return undefined;
  const title: unknown = parseDocument(yaml).getIn(["metadata", "title"]);
  return typeof title === "string" && title.trim().length > 0
    ? title.trim().slice(0, 256)
    : undefined;
}
