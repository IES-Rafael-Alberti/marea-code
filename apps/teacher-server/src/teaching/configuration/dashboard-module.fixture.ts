import {
  CURRENT_PROTOCOL_VERSION,
  SaveTeachingConfigurationRequestSchema,
  TeachingCatalogQuerySchema,
  TeachingClassesQuerySchema,
  TeachingConfigurationQuerySchema,
  SkillBundleSchema,
  type AgentMode,
  type Sha256Digest,
  type TeachingSettings,
} from "@marea/protocol";
import { vi } from "vitest";

import { TeacherDomainError } from "../../identity/errors.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { StoredTeachingConfiguration } from "./configuration-schema.js";
import type {
  TeachingOperatorConfiguration,
  TeachingOperatorPolicy,
} from "./dashboard-contracts.js";
import type { TeachingConfigurationRepository } from "./contracts.js";
import type {
  SkillBundle,
  SkillId,
  SkillKind,
  SkillSource,
  SkillSummary,
} from "../skills/index.js";
import { digestSkillFiles } from "../skills/skill-digest.js";
import type { TeachingClassDirectory, TeachingClassPageRequest } from "./dashboard-module.js";

export const teacher: AuthenticatedIdentity = {
  classId: null,
  displayName: "Synthetic teacher",
  role: "teacher",
  userId: "t1",
};

export const student: AuthenticatedIdentity = {
  classId: "class:one",
  displayName: "Synthetic student",
  role: "student",
  userId: "s1",
};

export const syntheticUsagePolicy = {
  version: "usage:1",
  costUnit: "credit",
  inputCostUnitsPerToken: 1,
  outputCostUnitsPerToken: 2,
  maxRequests: 10,
  maxTokens: 4_000,
  maxCostUnits: 10_000,
  maxConcurrentRequests: 1,
  maxRequestDurationMs: 5_000,
  maxInputTokens: 2_000,
  maxOutputTokens: 2_000,
  maxToolCalls: 5,
};

export const syntheticOperatorPolicy: TeachingOperatorPolicy = {
  route: {
    version: "route:1",
    modelAlias: "marea",
    providerRoute: {
      providerId: "synthetic-provider",
      model: "synthetic-model",
      budget: {
        inputTokenCeiling: 1_000,
        tutoring: syntheticUsagePolicy,
        evaluation: syntheticUsagePolicy,
      },
    },
  },
  teacherToolPolicy: {
    version: "policy:1",
    restrictions: [{ tool: "workspace.write", effect: "require-approval" }],
  },
};

export function operatorConfiguration(
  policies: Readonly<Record<string, TeachingOperatorPolicy | null>>,
): TeachingOperatorConfiguration {
  return { forClass: (classId) => policies[classId] ?? null };
}

const encodedLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export function syntheticSkill(kind: SkillKind, name: string): SkillBundle {
  const content = `---\nname: ${name}\ndescription: Synthetic ${name}\n---\n\nSynthetic ${name} instructions.\n`;
  const resource = `Frozen ${name} resource.\n`;
  const files = [
    { path: "SKILL.md", content, sizeBytes: encodedLength(content) },
    { path: "resources/guide.txt", content: resource, sizeBytes: encodedLength(resource) },
  ];
  return SkillBundleSchema.parse({
    id: (kind === "didactic" ? `teacher/t1/${name}` : `marea/${name}`) satisfies string,
    name,
    description: `Synthetic ${name}`,
    kind,
    source: kind === "didactic" ? "teacher" : "marea",
    digest: digestSkillFiles(files),
    license: "MIT",
    compatibility: null,
    criteria: [],
    files,
  });
}

export class MemorySkillSource implements SkillSource {
  readonly #bundles: readonly SkillBundle[];
  beforeList: (() => Promise<void>) | null = null;

  constructor(bundles: readonly SkillBundle[]) {
    this.#bundles = bundles;
  }

  async list(kind: SkillKind): Promise<readonly SkillSummary[]> {
    if (this.beforeList !== null) await this.beforeList();
    return this.#bundles
      .filter((bundle) => bundle.kind === kind)
      .map((bundle) => ({
        compatibility: bundle.compatibility,
        criteria: bundle.criteria,
        description: bundle.description,
        digest: bundle.digest,
        id: bundle.id,
        kind: bundle.kind,
        license: bundle.license,
        name: bundle.name,
        source: bundle.source,
      }));
  }

  load(id: SkillId): Promise<SkillBundle | null> {
    return Promise.resolve(this.#bundles.find((bundle) => bundle.id === id) ?? null);
  }
}

export class MemoryClassDirectory implements TeachingClassDirectory {
  readonly #rows: readonly { classId: string; displayName: string }[];

  constructor(rows: readonly { classId: string; displayName: string }[]) {
    this.#rows = rows;
  }

  listClasses(
    request: TeachingClassPageRequest,
  ): Promise<readonly { classId: string; displayName: string }[]> {
    const selected = this.#rows
      .filter((row) => request.afterClassId === null || row.classId > request.afterClassId)
      .slice(0, request.limit + 1);
    return Promise.resolve(selected);
  }
}

export class MemoryTeachingRepository implements TeachingConfigurationRepository {
  readonly #memberships = new Set<string>();
  #configuration: { classId: string; configuration: StoredTeachingConfiguration } | null = null;
  requireTeacherCalls = 0;

  grant(teacherId: string, classId: string): void {
    this.#memberships.add(`${teacherId}\u0000${classId}`);
  }

  revoke(teacherId: string, classId: string): void {
    this.#memberships.delete(`${teacherId}\u0000${classId}`);
  }

  requireTeacherClass(teacherId: string, classId: string): void {
    this.requireTeacherCalls += 1;
    if (!this.#memberships.has(`${teacherId}\u0000${classId}`)) {
      throw new TeacherDomainError("dashboard.forbidden");
    }
  }

  loadForTeacher(teacherId: string, classId: string): StoredTeachingConfiguration | null {
    this.requireTeacherClass(teacherId, classId);
    return this.#configuration?.classId === classId ? this.#configuration.configuration : null;
  }

  loadForStudent(): StoredTeachingConfiguration | null {
    throw new Error("Student loads are outside this module.");
  }

  saveRevision(input: {
    classId: string;
    configuration: StoredTeachingConfiguration;
    expectedVersion: string | null;
    teacherId: string;
  }): StoredTeachingConfiguration {
    this.requireTeacherClass(input.teacherId, input.classId);
    const current =
      this.#configuration?.classId === input.classId
        ? this.#configuration.configuration.content.configurationVersion
        : null;
    if (current !== input.expectedVersion) throw new TeacherDomainError("request.conflict");
    this.#configuration = { classId: input.classId, configuration: input.configuration };
    return input.configuration;
  }

  configurationFor(classId: string): StoredTeachingConfiguration | null {
    return this.#configuration?.classId === classId ? this.#configuration.configuration : null;
  }
}

export function teachingSettings(
  agentMode: AgentMode,
  didactic: readonly SkillBundle[],
  evaluation: readonly SkillBundle[],
): {
  agentMode: AgentMode;
  automaticEvaluation: boolean;
  classInstructions: { free: string; tutoring: string };
  selection: {
    didactic: readonly { digest: Sha256Digest; id: SkillId }[];
    evaluation: readonly { digest: Sha256Digest; id: SkillId }[];
  };
} {
  return {
    agentMode,
    automaticEvaluation: false,
    classInstructions: { tutoring: "Tutoring instructions.", free: "Free instructions." },
    selection: {
      didactic: didactic.map((bundle) => ({ id: bundle.id, digest: bundle.digest })),
      evaluation: evaluation.map((bundle) => ({ id: bundle.id, digest: bundle.digest })),
    },
  };
}

export function revisionIds() {
  let counter = 0;
  return { createId: vi.fn((namespace: "revision") => `${namespace}:test-${String(++counter)}`) };
}

export function classesQuery(afterClassId: string | null = null) {
  return TeachingClassesQuerySchema.parse({
    afterClassId,
    kind: "teaching-classes-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:classes",
  });
}

export function readQuery(classId = "class:one") {
  return TeachingConfigurationQuerySchema.parse({
    classId,
    kind: "teaching-configuration-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:read",
  });
}

export function catalogQuery(afterSkillId: string | null = null) {
  return TeachingCatalogQuerySchema.parse({
    afterSkillId,
    classId: "class:one",
    kind: "teaching-catalog-query",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:catalog",
  });
}

export function saveRequest(settings: TeachingSettings, expectedVersion: string | null = null) {
  return SaveTeachingConfigurationRequestSchema.parse({
    classId: "class:one",
    expectedVersion,
    kind: "teaching-configuration-save",
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId: "request:save",
    settings,
  });
}

export function policyWithoutBudget(): TeachingOperatorPolicy {
  const { version, modelAlias, providerRoute } = syntheticOperatorPolicy.route;
  const { model, providerId } = providerRoute;
  return {
    route: {
      modelAlias,
      providerRoute: { model, providerId },
      version,
    } as TeachingOperatorPolicy["route"],
    teacherToolPolicy: syntheticOperatorPolicy.teacherToolPolicy,
  };
}
