import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RequestIdSchema,
  SkillIdSchema,
  type SkillAuthoringDraft,
  type SkillId,
  type RequestId,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { TeachingConfigurationRepository } from "../configuration/contracts.js";
import { SkillAuthoringStore } from "../authoring/skill-authoring-store.boundary.js";
import type { SkillBundle, SkillKind, SkillSource, SkillSummary } from "../skills/skill-source.js";
import type {
  ProductSkillAuthoringServiceOptions,
  ProductSkillAuthoringWriter,
} from "./skill-authoring-service.js";

export const teacher: AuthenticatedIdentity = Object.freeze({
  classId: "class:physics",
  displayName: "Teacher Grace",
  role: "teacher",
  userId: "teacher:grace",
});

export const student: AuthenticatedIdentity = Object.freeze({
  classId: "class:physics",
  displayName: "Student Ada",
  role: "student",
  userId: "student:ada",
});

export function draft(
  kind: SkillKind = "didactic",
  slug = "practice",
  description = "Practice testing",
  resource = "The practice resource.",
): SkillAuthoringDraft {
  return {
    files: [
      {
        content: `---\nname: ${slug}\ndescription: ${description}\nlicense: CC0\n---\n\nTeach testing.\n`,
        path: "SKILL.md",
      },
      { content: resource, path: "resources/notes.txt" },
    ],
    kind,
    slug,
  };
}

export function request<T extends object, K extends string>(
  classId: string,
  kind: K,
  payload: T,
): T & { classId: string; kind: K; protocolVersion: "0.1"; requestId: RequestId } {
  return {
    classId,
    kind,
    ...payload,
    protocolVersion: "0.1",
    requestId: RequestIdSchema.parse(`request:${kind}`),
  };
}

export interface MembershipFixture {
  readonly repository: Pick<TeachingConfigurationRepository, "requireTeacherClass">;
  readonly revoke: () => void;
  readonly calls: number[];
}

export function temporaryRootRegistry(): {
  readonly add: (root: string) => void;
  readonly cleanup: () => Promise<void>;
} {
  const roots: string[] = [];
  return {
    add: (root) => roots.push(root),
    cleanup: async () => {
      await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
    },
  };
}

export function membership(): MembershipFixture {
  let allowed = true;
  const calls: number[] = [];
  return {
    calls,
    repository: {
      requireTeacherClass() {
        calls.push(calls.length + 1);
        if (!allowed) throw new TeacherDomainError("dashboard.forbidden");
      },
    },
    revoke: () => {
      allowed = false;
    },
  };
}

export async function realWriter(): Promise<{
  readonly root: string;
  readonly store: SkillAuthoringStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "marea-teaching-authoring-"));
  const store = new SkillAuthoringStore(join(root, "teacher"), {
    id: teacher.userId,
    source: "teacher",
  });
  await store.initialize();
  return { root, store };
}

export function sourceFrom(bundles: readonly SkillBundle[]): SkillSource {
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  return {
    list(kind: SkillKind): Promise<readonly SkillSummary[]> {
      return Promise.resolve(bundles.filter((bundle) => bundle.kind === kind).map(toSummary));
    },
    load(id: SkillId): Promise<SkillBundle | null> {
      return Promise.resolve(byId.get(id) ?? null);
    },
  };
}
export function serviceOptions(
  membershipFixture: MembershipFixture,
  writer: ProductSkillAuthoringWriter,
  source: SkillSource,
): ProductSkillAuthoringServiceOptions {
  return {
    membership: membershipFixture.repository,
    sourceForTeacherClass: () => source,
    writerForTeacher: () => writer,
  };
}

export async function writeCoreSkill(root: string): Promise<void> {
  await mkdir(join(root, "didactic", "core-practice", "resources"), { recursive: true });
  await mkdir(join(root, "evaluation"), { recursive: true });
  await writeFile(
    join(root, "didactic", "core-practice", "SKILL.md"),
    "---\nname: core-practice\ndescription: Core practice\nlicense: MIT\n---\n\nThe old slug is only in this prose.\n",
  );
  await writeFile(
    join(root, "didactic", "core-practice", "resources", "old-name.txt"),
    "Keep the old slug in this resource: core-practice.",
  );
}

export function personalId(slug: string): SkillId {
  return SkillIdSchema.parse(`teacher/${teacher.userId}/${slug}`);
}

function toSummary(bundle: SkillBundle): SkillSummary {
  const { compatibility, criteria, description, digest, id, kind, license, name, source } = bundle;
  return Object.freeze({
    compatibility,
    criteria,
    description,
    digest,
    id,
    kind,
    license,
    name,
    source,
  });
}
